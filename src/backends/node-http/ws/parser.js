const EMPTY = Buffer.alloc(0)

const GET_INFO = 0
const GET_LEN16 = 1
const GET_LEN64 = 2
const GET_MASK = 3
const GET_PAYLOAD = 4

/**
 * @param {number} code
 * @returns {boolean}
 */
function isValidCloseCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999)
}

/**
 * XOR-unmask a payload in place with a 4-byte mask key (4x unrolled).
 * @param {Buffer} buf
 * @param {Buffer} mask
 */
function unmask(buf, mask) {
  const len = buf.length
  const m0 = mask[0]
  const m1 = mask[1]
  const m2 = mask[2]
  const m3 = mask[3]
  const n = len - (len & 3)

  let i = 0

  for (; i < n; i += 4) {
    buf[i] ^= m0
    buf[i + 1] ^= m1
    buf[i + 2] ^= m2
    buf[i + 3] ^= m3
  }

  for (; i < len; i++) {
    buf[i] ^= mask[i & 3]
  }
}

export default class FrameParser {
  #maxPayload
  #onMessage
  #onPing
  #onPong
  #onClose
  #onError

  #buffers = []
  #bufferedBytes = 0

  #state = GET_INFO
  #errored = false

  #fin = false
  #opcode = 0
  #payloadLen = 0
  #mask = null

  // Message assembly across fragments.
  #fragmented = false
  #messageOpcode = 0
  #messageChunks = []
  #totalPayload = 0
  #decoder = null

  /**
   * @param {object} opt
   * @param {number} opt.maxPayload
   * @param {(payload: Buffer, isBinary: boolean) => void} opt.onMessage
   * @param {(payload: Buffer) => void} opt.onPing
   * @param {(payload: Buffer) => void} opt.onPong
   * @param {(code: number, reason: Buffer) => void} opt.onClose
   * @param {(code: number, message: string) => void} opt.onError
   */
  constructor({ maxPayload, onMessage, onPing, onPong, onClose, onError }) {
    this.#maxPayload = maxPayload
    this.#onMessage = onMessage
    this.#onPing = onPing
    this.#onPong = onPong
    this.#onClose = onClose
    this.#onError = onError
  }

  /**
   * @param {Buffer} chunk
   */
  push(chunk) {
    if (this.#errored) {
      return
    }

    if (chunk.length) {
      this.#buffers.push(chunk)
      this.#bufferedBytes += chunk.length
    }

    this.#run()
  }

  /**
   * @param {number} n
   * @returns {Buffer}
   */
  #consume(n) {
    this.#bufferedBytes -= n

    const first = this.#buffers[0]

    if (n === first.length) {
      return this.#buffers.shift()
    }

    if (n < first.length) {
      this.#buffers[0] = first.subarray(n)
      return first.subarray(0, n)
    }

    const dst = Buffer.allocUnsafe(n)
    let offset = 0

    while (offset < n) {
      const buf = this.#buffers[0]
      const need = n - offset

      if (need >= buf.length) {
        dst.set(buf, offset)
        offset += buf.length
        this.#buffers.shift()
      } else {
        dst.set(buf.subarray(0, need), offset)
        this.#buffers[0] = buf.subarray(need)
        offset += need
      }
    }

    return dst
  }

  #run() {
    while (!this.#errored) {
      if (this.#state === GET_INFO) {
        if (this.#bufferedBytes < 2) {
          return
        }

        this.#getInfo()
      } else if (this.#state === GET_LEN16) {
        if (this.#bufferedBytes < 2) {
          return
        }

        this.#payloadLen = this.#consume(2).readUInt16BE(0)
        this.#haveLength()
      } else if (this.#state === GET_LEN64) {
        if (this.#bufferedBytes < 8) {
          return
        }

        const buf = this.#consume(8)

        if (buf.readUInt32BE(0) !== 0) {
          this.#fail(1009, 'message too large')
          return
        }

        this.#payloadLen = buf.readUInt32BE(4)
        this.#haveLength()
      } else if (this.#state === GET_MASK) {
        if (this.#bufferedBytes < 4) {
          return
        }

        this.#mask = this.#consume(4)
        this.#state = GET_PAYLOAD
      } else {
        if (this.#bufferedBytes < this.#payloadLen) {
          return
        }

        this.#getPayload()
      }
    }
  }

  #getInfo() {
    const buf = this.#consume(2)
    const b0 = buf[0]
    const b1 = buf[1]

    if ((b0 & 0x70) !== 0) {
      return this.#fail(1002, 'RSV bits must be clear')
    }

    this.#fin = (b0 & 0x80) === 0x80
    this.#opcode = b0 & 0x0f

    if ((b1 & 0x80) !== 0x80) {
      return this.#fail(1002, 'client frames must be masked')
    }

    const len = b1 & 0x7f
    const opcode = this.#opcode

    if (opcode === 0) {
      if (!this.#fragmented) {
        return this.#fail(1002, 'continuation frame without a started message')
      }
    } else if (opcode === 1 || opcode === 2) {
      if (this.#fragmented) {
        return this.#fail(1002, 'expected a continuation frame')
      }

      this.#messageOpcode = opcode
      this.#messageChunks = []
      this.#totalPayload = 0

      if (opcode === 1) {
        this.#decoder = new TextDecoder('utf-8', { fatal: true })
      }
    } else if (opcode === 8 || opcode === 9 || opcode === 10) {
      if (!this.#fin) {
        return this.#fail(1002, 'control frames must not be fragmented')
      }

      if (len > 125) {
        return this.#fail(1002, 'control frames must be <= 125 bytes')
      }
    } else {
      return this.#fail(1002, 'reserved opcode')
    }

    if (len === 126) {
      this.#state = GET_LEN16
    } else if (len === 127) {
      this.#state = GET_LEN64
    } else {
      this.#payloadLen = len
      this.#haveLength()
    }
  }

  #haveLength() {
    if (this.#opcode < 3) {
      const total = this.#totalPayload + this.#payloadLen

      if (total > this.#maxPayload) {
        return this.#fail(1009, 'message too large')
      }

      this.#totalPayload = total
    }

    this.#state = GET_MASK
  }

  #getPayload() {
    let payload = EMPTY

    if (this.#payloadLen > 0) {
      payload = this.#consume(this.#payloadLen)
      unmask(payload, this.#mask)
    }

    this.#state = GET_INFO
    this.#handleFrame(payload)
  }

  /**
   * @param {Buffer} payload
   */
  #handleFrame(payload) {
    const opcode = this.#opcode

    if (opcode === 8) {
      return this.#handleClose(payload)
    }

    if (opcode === 9) {
      return this.#onPing(payload)
    }

    if (opcode === 10) {
      return this.#onPong(payload)
    }

    if (payload.length) {
      this.#messageChunks.push(payload)
    }

    if (this.#messageOpcode === 1 && payload.length) {
      try {
        this.#decoder.decode(payload, { stream: true })
      } catch {
        return this.#fail(1007, 'invalid UTF-8 in text message')
      }
    }

    if (!this.#fin) {
      this.#fragmented = true
      return
    }

    if (this.#messageOpcode === 1) {
      try {
        this.#decoder.decode()
      } catch {
        return this.#fail(1007, 'invalid UTF-8 in text message')
      }
    }

    const chunks = this.#messageChunks
    const full =
      chunks.length === 0 ? EMPTY : chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, this.#totalPayload)

    this.#fragmented = false
    this.#messageChunks = []
    this.#totalPayload = 0

    this.#onMessage(full, this.#messageOpcode === 2)
  }

  /**
   * @param {Buffer} payload
   */
  #handleClose(payload) {
    const len = payload.length

    if (len === 0) {
      return this.#onClose(1005, EMPTY)
    }

    if (len === 1) {
      return this.#fail(1002, 'invalid close frame payload')
    }

    const code = payload.readUInt16BE(0)

    if (!isValidCloseCode(code)) {
      return this.#fail(1002, 'invalid close code')
    }

    const reason = payload.subarray(2)

    if (reason.length) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(reason)
      } catch {
        return this.#fail(1007, 'invalid UTF-8 in close reason')
      }
    }

    // A close frame terminates the stream: stop parsing so trailing frames in
    // the same chunk are not processed (RFC 6455 - nothing follows a Close).
    this.#errored = true
    this.#buffers = []
    this.#bufferedBytes = 0

    this.#onClose(code, reason)
  }

  /**
   * @param {number} code
   * @param {string} message
   */
  #fail(code, message) {
    if (this.#errored) {
      return
    }

    this.#errored = true
    this.#buffers = []
    this.#bufferedBytes = 0

    this.#onError(code, message)
  }
}

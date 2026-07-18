const EMPTY = Buffer.alloc(0)
const GET_INFO = 0
const GET_LEN16 = 1
const GET_LEN64 = 2
const GET_MASK = 3
const GET_PAYLOAD = 4
const QUEUE_BLOCK_SIZE = 16 * 1024

/**
 * Byte queue optimized for both normal socket chunks and adversarial tiny
 * chunks. Large chunks stay zero-copy; small chunks are copied into fixed-size
 * blocks so one-byte writes cannot create one retained Buffer object each.
 */
class BufferQueue {
  #blocks = []
  #head = 0

  length = 0

  /**
   * @param {Buffer} chunk
   */
  push(chunk) {
    let offset = 0
    let remaining = chunk.length
    let tail = this.#blocks[this.#blocks.length - 1]

    if (tail && !tail.owned && remaining < QUEUE_BLOCK_SIZE) {
      const retained = tail.end - tail.start

      if (retained < QUEUE_BLOCK_SIZE) {
        const buffer = Buffer.allocUnsafe(QUEUE_BLOCK_SIZE)

        tail.buffer.copy(buffer, 0, tail.start, tail.end)
        tail = { buffer, start: 0, end: retained, owned: true }
        this.#blocks[this.#blocks.length - 1] = tail
      }
    }

    if (tail?.owned && tail.end < tail.buffer.length) {
      const copyLength = Math.min(remaining, tail.buffer.length - tail.end)

      chunk.copy(tail.buffer, tail.end, offset, offset + copyLength)
      tail.end += copyLength
      offset += copyLength
      remaining -= copyLength
    }

    if (remaining > 0) {
      this.#blocks.push({ buffer: chunk, start: offset, end: chunk.length, owned: false })
    }

    this.length += chunk.length
  }

  /**
   * @param {number} n
   * @returns {Buffer}
   */
  consume(n) {
    this.length -= n

    const first = this.#blocks[this.#head]
    const available = first.end - first.start

    if (n <= available) {
      const out = first.buffer.subarray(first.start, first.start + n)

      first.start += n

      if (first.start === first.end) {
        this.#releaseHead()
      }

      return out
    }

    const out = Buffer.allocUnsafe(n)

    let offset = 0

    while (offset < n) {
      const block = this.#blocks[this.#head]
      const blockLength = block.end - block.start
      const copyLength = Math.min(n - offset, blockLength)

      block.buffer.copy(out, offset, block.start, block.start + copyLength)
      block.start += copyLength
      offset += copyLength

      if (block.start === block.end) {
        this.#releaseHead()
      }
    }

    return out
  }

  clear() {
    this.#blocks = []
    this.#head = 0
    this.length = 0
  }

  #releaseHead() {
    this.#blocks[this.#head++] = null

    if (this.#head >= 64 && this.#head * 2 >= this.#blocks.length) {
      this.#blocks = this.#blocks.slice(this.#head)
      this.#head = 0
    }
  }
}

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

  #queue = new BufferQueue()

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
      this.#queue.push(chunk)
    }

    this.#run()
  }

  /**
   * Whether a partial frame or fragmented message is currently retained.
   * @returns {boolean}
   */
  get pending() {
    return !this.#errored && (this.#fragmented || this.#state !== GET_INFO || this.#queue.length > 0)
  }

  /** Stop parsing and release all retained input without emitting an error. */
  stop() {
    this.#errored = true
    this.#clearBuffered()
  }

  #clearBuffered() {
    this.#queue.clear()
    this.#messageChunks = []
    this.#totalPayload = 0
  }

  /**
   * @param {number} n
   * @returns {Buffer}
   */
  #consume(n) {
    return this.#queue.consume(n)
  }

  #run() {
    while (!this.#errored) {
      if (this.#state === GET_INFO) {
        if (this.#queue.length < 2) {
          return
        }

        this.#getInfo()
      } else if (this.#state === GET_LEN16) {
        if (this.#queue.length < 2) {
          return
        }

        this.#payloadLen = this.#consume(2).readUInt16BE(0)

        if (this.#payloadLen < 126) {
          this.#fail(1002, 'non-canonical 16-bit payload length')

          return
        }

        this.#haveLength()
      } else if (this.#state === GET_LEN64) {
        if (this.#queue.length < 8) {
          return
        }

        const buf = this.#consume(8)
        const high = buf.readUInt32BE(0)
        const low = buf.readUInt32BE(4)

        if ((high & 0x80000000) !== 0) {
          this.#fail(1002, 'invalid 64-bit payload length')

          return
        }

        if (high !== 0) {
          this.#fail(1009, 'message too large')

          return
        }

        if (low < 65536) {
          this.#fail(1002, 'non-canonical 64-bit payload length')

          return
        }

        this.#payloadLen = low
        this.#haveLength()
      } else if (this.#state === GET_MASK) {
        if (this.#queue.length < 4) {
          return
        }

        this.#mask = this.#consume(4)
        this.#state = GET_PAYLOAD
      } else {
        if (this.#queue.length < this.#payloadLen) {
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
   * @returns {void}
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
   * @returns {void}
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
    this.#clearBuffered()

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
    this.#clearBuffered()

    this.#onError(code, message)
  }
}

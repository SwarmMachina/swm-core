export interface PackageManifest {
  name: string
  imports?: Record<string, string | Record<string, string>>
}

const CORE_PACKAGE_NAME = '@swarmmachina/swm-core'

/**
 * Reject test-only native-binding injection from the publishable core manifest.
 */
export function assertCorePackageIsolation(pkg: PackageManifest): void {
  if (pkg.name !== CORE_PACKAGE_NAME) {
    return
  }

  const bindingImport = pkg.imports?.['#uws-binding']

  if (!bindingImport || typeof bindingImport !== 'object') {
    throw new Error('swm-core package is missing #uws-binding')
  }

  if (Object.hasOwn(bindingImport, 'swm-core-test')) {
    throw new Error('swm-core tarball must not reference the disposable test build')
  }
}

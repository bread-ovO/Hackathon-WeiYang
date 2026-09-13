export function bundleDefaultPet(root?: string): Promise<void>
export default function beforePack(): Promise<void>
export function verifyPackagedPet(context: {
  electronPlatformName: string
  appOutDir: string
  packager: { appInfo: { productFilename: string } }
}): Promise<void>

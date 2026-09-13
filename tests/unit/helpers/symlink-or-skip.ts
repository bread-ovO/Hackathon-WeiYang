import { symlink } from 'node:fs/promises'

/** Create a symlink or skip the test when the OS denies it.
 *
 * Windows without Developer Mode (or admin) rejects symlink creation with
 * EPERM, so symlink-dependent cases can only run where the OS allows them.
 * macOS/Linux CI is unaffected. Pattern introduced in pet-model-validation
 * tests and shared here so every suite behaves the same way.
 */
export async function symlinkOrSkip(
  ctx: { skip(): void },
  target: string,
  link: string,
): Promise<void> {
  try {
    await symlink(target, link)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      ctx.skip()
      return
    }
    throw error
  }
}

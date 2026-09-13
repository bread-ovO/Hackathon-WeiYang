// Compatibility entrypoint for development tests. All release packages use the mandatory builder hook.
import { bundleDefaultPet } from './bundle-default-pet.mjs'
await bundleDefaultPet()
console.log('Bundled default Hiyori and pinned runtime.')

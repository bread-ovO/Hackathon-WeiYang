export interface ModelProvider {
  extract(input:{text:string; signal:AbortSignal}):Promise<unknown>
}
// Provider results must be validated by application contracts before use.

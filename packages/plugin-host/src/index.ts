export interface SourceManifest {
  id:string; version:string; schemaVersion:1
  permissions: { domains:readonly string[]; directories:readonly string[] }
}
// Protocol only. No arbitrary plugin code is loaded by this scaffold.

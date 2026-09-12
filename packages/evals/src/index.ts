export interface ReplayStep { occurredAt:string; input:unknown; expected:unknown }
export interface ReplayScenario { id:string; steps:readonly ReplayStep[] }
// Real, authorized scenario fixtures will be added after source access validation.

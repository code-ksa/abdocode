export type ComputerLane = "accessibility" | "vision" | "pointer"
export interface TargetReference { readonly id: string; readonly generation: number; readonly lane: ComputerLane }
export interface SurfaceSnapshot { readonly generation: number; readonly targetIds: readonly string[] }

export function bindTarget(snapshot: SurfaceSnapshot, id: string, lane: ComputerLane): TargetReference {
  if (!snapshot.targetIds.includes(id)) throw new Error("computer_target_missing")
  return Object.freeze({ id, generation: snapshot.generation, lane })
}

export function admitComputerAction(snapshot: SurfaceSnapshot, target: TargetReference): void {
  if (target.generation !== snapshot.generation) throw new Error("stale_computer_target")
  if (!snapshot.targetIds.includes(target.id)) throw new Error("computer_target_missing")
}

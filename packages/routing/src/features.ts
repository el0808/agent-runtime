import type { JsonObject, TaskProfile } from "@agent/protocol";

export interface TaskFeatures {
  readonly wordCount: number;
  readonly estimatedSteps: number;
  readonly complexity: 1 | 2 | 3 | 4 | 5;
  readonly longRunning: boolean;
  readonly fixedFlow: boolean;
  readonly hasExternalSideEffect: boolean;
  readonly signals: readonly string[];
}

function metadataBoolean(metadata: JsonObject | undefined, key: string): boolean {
  return metadata?.[key] === true;
}

export function extractTaskFeatures(profile: TaskProfile): TaskFeatures {
  const goal = profile.goal.trim();
  const wordCount = goal.length === 0 ? 0 : goal.split(/\s+/u).length;
  const signals: string[] = [];
  const lower = goal.toLowerCase();
  const stepMatches = lower.match(/\b(first|then|next|finally|step|步骤|然后|接着|最后)\b/gu)?.length ?? 0;
  const estimatedSteps = Math.max(1, stepMatches + (metadataBoolean(profile.metadata, "estimatedSteps") ? Number(profile.metadata?.estimatedSteps) || 1 : 0));
  const fixedFlow = metadataBoolean(profile.metadata, "fixedFlow") || /\b(workflow|pipeline|state graph|固定流程|审批)\b/u.test(lower);
  const longRunning = metadataBoolean(profile.metadata, "longRunning") || metadataBoolean(profile.metadata, "background") || /\b(long|overnight|background|持续|长任务)\b/u.test(lower);
  const hasExternalSideEffect = metadataBoolean(profile.metadata, "externalSideEffect") || /\b(delete|deploy|send|publish|迁移|删除|部署|发送)\b/u.test(lower);
  if (estimatedSteps > 1) signals.push("multi-step");
  if (fixedFlow) signals.push("fixed-flow");
  if (longRunning) signals.push("long-running");
  if (hasExternalSideEffect) signals.push("external-side-effect");
  const complexity = fixedFlow || hasExternalSideEffect ? 4 : longRunning || estimatedSteps >= 4 ? 4 : estimatedSteps >= 2 || wordCount > 30 ? 3 : wordCount > 12 ? 2 : 1;
  return { wordCount, estimatedSteps, complexity: Math.min(5, complexity) as 1 | 2 | 3 | 4 | 5, longRunning, fixedFlow, hasExternalSideEffect, signals };
}

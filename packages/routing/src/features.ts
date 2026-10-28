import type { JsonObject, TaskProfile } from "@agent/protocol";

export interface TaskFeatures {
  readonly wordCount: number;
  readonly estimatedSteps: number;
  readonly complexity: 1 | 2 | 3 | 4 | 5;
  readonly longRunning: boolean;
  readonly fixedFlow: boolean;
  readonly hasExternalSideEffect: boolean;
  readonly needsParallelism: boolean;
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
  // Count the segments the planner will actually produce. Counting keywords
  // instead was wrong in both directions: "…, then verify it" is two steps but
  // has one marker, while "first. second. third." has three markers but is
  // three steps, not four. Routing decisions depend on this number.
  const segments = profile.goal
    .split(/\r?\n|(?<=[.!?])\s+|(?<=[;；])\s*/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const declared = metadataBoolean(profile.metadata, "estimatedSteps") ? Number(profile.metadata?.estimatedSteps) || 1 : 0;
  // Punctuation is not the only way to write steps: "first then next finally"
  // is four steps in one sentence, so take whichever signal is larger.
  const markers = profile.goal.toLowerCase().match(/\b(first|then|next|finally|step)\b|然后|接着|最后|步骤/gu)?.length ?? 0;
  const estimatedSteps = Math.max(1, segments.length, markers, declared);
  const fixedFlow = metadataBoolean(profile.metadata, "fixedFlow") || /\b(workflow|pipeline|state graph|固定流程|审批)\b/u.test(lower);
  const longRunning = metadataBoolean(profile.metadata, "longRunning") || metadataBoolean(profile.metadata, "background") || /\b(long|overnight|background|持续|长任务)\b/u.test(lower);
  const hasExternalSideEffect = metadataBoolean(profile.metadata, "externalSideEffect") || /\b(delete|deploy|send|publish|迁移|删除|部署|发送)\b/u.test(lower);
  const needsParallelism = metadataBoolean(profile.metadata, "multiAgent") || /\b(parallel|concurrently|多个角色|并行|团队)\b/u.test(lower);
  if (estimatedSteps > 1) signals.push("multi-step");
  if (fixedFlow) signals.push("fixed-flow");
  if (longRunning) signals.push("long-running");
  if (hasExternalSideEffect) signals.push("external-side-effect");
  if (needsParallelism) signals.push("parallel-roles");
  const complexity = fixedFlow || hasExternalSideEffect ? 4 : longRunning || estimatedSteps >= 4 ? 4 : estimatedSteps >= 2 || wordCount > 30 ? 3 : wordCount > 12 ? 2 : 1;
  return {
    wordCount,
    estimatedSteps,
    complexity: Math.min(5, complexity) as 1 | 2 | 3 | 4 | 5,
    longRunning,
    fixedFlow,
    hasExternalSideEffect,
    needsParallelism,
    signals
  };
}

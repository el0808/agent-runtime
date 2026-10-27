export interface TaskStateView {
  readonly taskId: string;
  readonly status: string;
  readonly completedSteps: readonly string[];
  readonly lastEventSequence: number;
}

export interface RuntimeEventView {
  readonly type: string;
  readonly sequence: number;
  readonly payload: Record<string, unknown>;
}

/** Thin HTTP client over the gateway. No domain logic lives here. */
export class GatewayClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) }
    });
    const text = await response.text();
    const body = text === "" ? undefined : (JSON.parse(text) as unknown);
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : response.statusText;
      throw new Error(`${response.status} ${message}`);
    }
    return body as T;
  }

  createTask(goal: string, runnerType?: string): Promise<TaskStateView> {
    return this.request<TaskStateView>("/tasks", {
      method: "POST",
      body: JSON.stringify(runnerType === undefined ? { goal } : { goal, runnerType })
    });
  }

  runTask(taskId: string): Promise<{ events: RuntimeEventView[]; state: TaskStateView }> {
    return this.request("/tasks/" + encodeURIComponent(taskId) + "/run", { method: "POST", body: "{}" });
  }

  getTask(taskId: string): Promise<TaskStateView> {
    return this.request<TaskStateView>("/tasks/" + encodeURIComponent(taskId));
  }

  getEvents(taskId: string): Promise<RuntimeEventView[]> {
    return this.request<RuntimeEventView[]>("/tasks/" + encodeURIComponent(taskId) + "/events");
  }

  pendingApprovals(taskId: string): Promise<string[]> {
    return this.request<string[]>("/tasks/" + encodeURIComponent(taskId) + "/approvals");
  }

  decideApproval(taskId: string, approvalId: string, decision: "approve" | "reject"): Promise<unknown> {
    return this.request("/tasks/" + encodeURIComponent(taskId) + "/approvals", {
      method: "POST",
      body: JSON.stringify({ approvalId, decision })
    });
  }

  verify(taskId: string): Promise<{ status: string; summary: string }> {
    return this.request("/tasks/" + encodeURIComponent(taskId) + "/verify", { method: "POST", body: "{}" });
  }
}

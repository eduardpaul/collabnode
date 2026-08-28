export type PlannerLanguage = "en" | "es";

export type PlannerStatus = "idle" | "planning" | "waiting_user_validation" | "approved";

export interface AgentLog {
  actor: "manager" | "architect" | "user" | "system";
  text: string;
  at: string;
}

export type PlannerLanguage = "en" | "es";

export type PlannerStatus = "idle" | "planning" | "waiting_user_validation" | "approved";

export type PlannerMode = "initial" | "revise";

export interface AgentLog {
  actor: "manager" | "architect" | "user" | "system";
  text: string;
  at: string;
}

export interface UserValidationPayload {
  assumptionId: string;
  approved: boolean;
  comment?: string;
}

export interface PlannerState {
  workspaceId: string;
  description: string;
  language: PlannerLanguage;
  iteration: number;
  managerAgrees: boolean;
  architectAgrees: boolean;
  status: PlannerStatus;
  mode: PlannerMode;
  /** Optional human guidance for a dirty-node revision. */
  reviewMessage?: string;
  activeAssumptionId?: string;
  userValidation?: UserValidationPayload;
  logs: AgentLog[];
}

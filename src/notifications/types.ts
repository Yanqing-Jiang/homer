export type NotificationIntent =
  | "decision_request"
  | "user_info"
  | "operational_status"
  | "failure_alert";

export type NotificationDecision = "sent" | "suppressed";

export type NotificationSourceType =
  | "scheduler_job"
  | "job_handler"
  | "overnight"
  | "bot_handler"
  | "system";

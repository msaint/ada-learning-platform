import { randomUUID } from "node:crypto";
import type postgres from "postgres";

type JsonWrapper = { __adaJson: unknown };
type IdentWrapper = { __adaIdent: string };
type ListWrapper = { __adaList: unknown[] };

function isJsonWrapper(v: unknown): v is JsonWrapper {
  return typeof v === "object" && v !== null && "__adaJson" in v;
}
function isIdentWrapper(v: unknown): v is IdentWrapper {
  return typeof v === "object" && v !== null && "__adaIdent" in v;
}
function isListWrapper(v: unknown): v is ListWrapper {
  return typeof v === "object" && v !== null && "__adaList" in v;
}

function unwrap(v: unknown): unknown {
  if (isJsonWrapper(v)) return structuredClone(v.__adaJson);
  if (isListWrapper(v)) return v.__adaList;
  if (typeof v === "object" && v !== null && "type" in v && (v as { type?: number }).type === 3802 && "value" in v) {
    const raw = (v as { raw?: unknown; value?: string }).raw;
    if (raw !== undefined) return structuredClone(raw);
    try {
      return JSON.parse(String((v as { value: string }).value));
    } catch {
      return {};
    }
  }
  return v;
}

function asDate(v: unknown): Date {
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") return new Date(v);
  return new Date();
}

function parseIntervalMs(raw: string): number {
  const m = raw.trim().match(/^(-?\d+(?:\.\d+)?)\s*(millisecond|milliseconds|second|seconds|minute|minutes|hour|hours|day|days)$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("millisecond")) return n;
  if (unit.startsWith("second")) return n * 1000;
  if (unit.startsWith("minute")) return n * 60_000;
  if (unit.startsWith("hour")) return n * 3_600_000;
  if (unit.startsWith("day")) return n * 86_400_000;
  return 0;
}

function duplicateKeyError(): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
}

interface UserRecord {
  id: string;
  email: string | null;
  password_hash: string | null;
  is_guest: boolean;
  guest_ip_hash: string | null;
  email_verified_at: Date | null;
  created_at: Date;
}

interface AuthSessionRecord {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
}

interface ProfileRecord {
  user_id: string;
  display_name: string | null;
  timezone: string;
  created_at: Date;
  updated_at: Date;
}

interface UserPreferencesRecord {
  owner_id: string;
  reminders_enabled: boolean;
  email_opt_in: boolean;
  quiet_hours_json: { start: string; end: string };
  daily_nudge_limit: number;
  weekly_nudge_limit: number;
  unsubscribe_token: string;
  updated_at: Date;
}

interface CourseDraftRecord {
  id: string;
  owner_id: string;
  topic: string;
  state_json: Record<string, unknown>;
  turns_json: unknown[];
  status: "collecting" | "ready" | "converted";
  proposal_json: unknown;
  version: number;
  idempotency_key: string;
  converted_course_id: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface CourseRecord {
  id: string;
  owner_id: string;
  draft_id: string | null;
  title: string;
  topic: string;
  intent: "curiosity" | "goal";
  status: "active" | "paused" | "archived";
  active_goal_version_id: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  last_opened_at: Date;
}

interface CourseGoalVersionRecord {
  id: string;
  course_id: string;
  version: number;
  intent: "curiosity" | "goal";
  goal_text: string;
  success_criteria_json: string[];
  time_budget_minutes_weekly: number | null;
  baseline_json: Record<string, unknown>;
  depth: string | null;
  deadline_at: Date | null;
  reason: string | null;
  created_at: Date;
}

interface ConceptRecord {
  id: string;
  course_id: string;
  slug: string;
  title: string;
  description: string;
  assessment_criteria_json: string[];
  importance: number;
  position: number;
  origin: "initial" | "branch" | "revision";
  status: "active" | "retired";
  created_at: Date;
}

interface ConceptEdgeRecord {
  course_id: string;
  from_concept_id: string;
  to_concept_id: string;
  edge_type: "prerequisite" | "related";
}

interface CurriculumVersionRecord {
  id: string;
  course_id: string;
  version: number;
  plan_json: Record<string, unknown>;
  reason: string;
  model_info_json: Record<string, unknown>;
  created_at: Date;
}

interface SessionRecord {
  id: string;
  course_id: string;
  owner_id: string;
  kind: string;
  status: "active" | "paused" | "completed";
  started_at: Date;
  ended_at: Date | null;
  current_activity_id: string | null;
  checkpoint_json: Record<string, unknown>;
  idempotency_key: string | null;
  version: number;
}

interface ActivityRecord {
  id: string;
  session_id: string;
  course_id: string;
  concept_id: string;
  review_item_id: string | null;
  sequence_no: number;
  kind: string;
  purpose: string;
  spec_json: Record<string, unknown>;
  status: "presented" | "evaluating" | "answered" | "completed";
  hints_json: unknown[];
  alt_explanations_json: unknown[];
  model_info_json: Record<string, unknown>;
  created_at: Date;
}

interface ActivityDraftRecord {
  activity_id: string;
  owner_id: string;
  draft_json: Record<string, unknown>;
  version: number;
  updated_at: Date;
}

interface AttemptRecord {
  id: string;
  activity_id: string;
  owner_id: string;
  submission_json: Record<string, unknown>;
  hint_count: number;
  explanation_revealed: boolean;
  idempotency_key: string;
  status: "pending_evaluation" | "graded";
  feedback_json: Record<string, unknown> | null;
  submitted_at: Date;
}

interface EvidenceRecord {
  id: string;
  attempt_id: string;
  course_id: string;
  concept_id: string;
  activity_kind: string;
  purpose: string;
  result: string;
  score: number | null;
  independence: string;
  difficulty: number | null;
  rubric_json: unknown;
  reason: string;
  evaluator_json: Record<string, unknown>;
  recall: "prompted" | "unprompted";
  created_at: Date;
}

interface MasteryRecord {
  course_id: string;
  concept_id: string;
  status: string;
  confidence: string;
  last_independent_success_at: Date | null;
  last_assessed_at: Date | null;
  details_json: Record<string, unknown>;
  updated_at: Date;
}

interface ReviewItemRecord {
  id: string;
  course_id: string;
  concept_id: string;
  owner_id: string;
  due_at: Date;
  interval_days: number;
  repetitions: number;
  status: "active" | "completed" | "cancelled";
  last_review_at: Date | null;
  created_at: Date;
}

interface CourseEventRecord {
  id: string;
  course_id: string;
  event_type: string;
  payload_json: Record<string, unknown>;
  created_at: Date;
}

interface NotificationLogRecord {
  id: string;
  owner_id: string;
  course_id: string | null;
  channel: string;
  status: string;
  idempotency_key: string;
  payload_json: Record<string, unknown>;
  created_at: Date;
  sent_at: Date | null;
}

interface SourceReferenceRecord {
  id: string;
  course_id: string;
  activity_id: string | null;
  title: string;
  url: string;
  retrieved_at: Date;
  source_type: string;
}

interface ModelUsageRecord {
  id: number;
  owner_id: string | null;
  operation: string;
  provider: string;
  model: string;
  ok: boolean;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  error_code: string | null;
  created_at: Date;
}

interface TelemetryEventRecord {
  id: number;
  owner_id: string | null;
  event_type: string;
  props_json: Record<string, unknown>;
  created_at: Date;
}

interface PreparedActivityRecord {
  id: string;
  session_id: string;
  after_activity_id: string;
  signature: string;
  mode: string;
  status: string;
  spec_json: unknown;
  model_info_json: unknown;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

interface WorkClaimRecord {
  resource: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}

interface AuthAttemptRecord {
  id: number;
  email_hash: string;
  ip_hash: string | null;
  ok: boolean;
  created_at: Date;
}

interface EmailTokenRecord {
  id: string;
  user_id: string;
  purpose: string;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

interface MemoryStore {
  seq: number;
  users: UserRecord[];
  auth_sessions: AuthSessionRecord[];
  profiles: ProfileRecord[];
  user_preferences: UserPreferencesRecord[];
  course_drafts: CourseDraftRecord[];
  courses: CourseRecord[];
  course_goal_versions: CourseGoalVersionRecord[];
  concepts: ConceptRecord[];
  concept_edges: ConceptEdgeRecord[];
  course_curriculum_versions: CurriculumVersionRecord[];
  sessions: SessionRecord[];
  activities: ActivityRecord[];
  activity_drafts: ActivityDraftRecord[];
  attempts: AttemptRecord[];
  assessment_evidence: EvidenceRecord[];
  mastery_estimates: MasteryRecord[];
  review_items: ReviewItemRecord[];
  course_events: CourseEventRecord[];
  notification_log: NotificationLogRecord[];
  source_references: SourceReferenceRecord[];
  model_usage: ModelUsageRecord[];
  telemetry_events: TelemetryEventRecord[];
  prepared_activities: PreparedActivityRecord[];
  work_claims: WorkClaimRecord[];
  auth_attempts: AuthAttemptRecord[];
  email_tokens: EmailTokenRecord[];
}

const globalForMem = globalThis as unknown as { __adaMemoryStore?: MemoryStore; __adaMemoryWarned?: boolean };

function getStore(): MemoryStore {
  if (!globalForMem.__adaMemoryStore) {
    globalForMem.__adaMemoryStore = {
      seq: 1,
      users: [],
      auth_sessions: [],
      profiles: [],
      user_preferences: [],
      course_drafts: [],
      courses: [],
      course_goal_versions: [],
      concepts: [],
      concept_edges: [],
      course_curriculum_versions: [],
      sessions: [],
      activities: [],
      activity_drafts: [],
      attempts: [],
      assessment_evidence: [],
      mastery_estimates: [],
      review_items: [],
      course_events: [],
      notification_log: [],
      source_references: [],
      model_usage: [],
      telemetry_events: [],
      prepared_activities: [],
      work_claims: [],
      auth_attempts: [],
      email_tokens: [],
    };
  }
  return globalForMem.__adaMemoryStore;
}

function resultWithCount<T>(rows: T[], count = rows.length): T[] & { count: number } {
  return Object.assign(rows, { count });
}

function cascadeDeleteCourse(s: MemoryStore, courseId: string) {
  const activityIds = new Set(s.activities.filter((a) => a.course_id === courseId).map((a) => a.id));
  const sessionIds = new Set(s.sessions.filter((x) => x.course_id === courseId).map((x) => x.id));
  s.courses = s.courses.filter((c) => c.id !== courseId);
  s.course_goal_versions = s.course_goal_versions.filter((g) => g.course_id !== courseId);
  s.concepts = s.concepts.filter((c) => c.course_id !== courseId);
  s.concept_edges = s.concept_edges.filter((e) => e.course_id !== courseId);
  s.course_curriculum_versions = s.course_curriculum_versions.filter((v) => v.course_id !== courseId);
  s.sessions = s.sessions.filter((x) => x.course_id !== courseId);
  s.activities = s.activities.filter((a) => a.course_id !== courseId);
  s.activity_drafts = s.activity_drafts.filter((d) => !activityIds.has(d.activity_id));
  s.attempts = s.attempts.filter((a) => !activityIds.has(a.activity_id));
  s.prepared_activities = s.prepared_activities.filter((p) => !sessionIds.has(p.session_id) && !activityIds.has(p.after_activity_id));
  s.assessment_evidence = s.assessment_evidence.filter((e) => e.course_id !== courseId);
  s.mastery_estimates = s.mastery_estimates.filter((m) => m.course_id !== courseId);
  s.review_items = s.review_items.filter((r) => r.course_id !== courseId);
  s.course_events = s.course_events.filter((e) => e.course_id !== courseId);
  s.notification_log = s.notification_log.filter((n) => n.course_id !== courseId);
  s.source_references = s.source_references.filter((r) => r.course_id !== courseId);
  for (const d of s.course_drafts) {
    if (d.converted_course_id === courseId) d.converted_course_id = null;
  }
}

function cascadeDeleteUser(s: MemoryStore, userId: string) {
  for (const c of s.courses.filter((x) => x.owner_id === userId)) {
    cascadeDeleteCourse(s, c.id);
  }
  s.users = s.users.filter((u) => u.id !== userId);
  s.auth_sessions = s.auth_sessions.filter((x) => x.user_id !== userId);
  s.profiles = s.profiles.filter((p) => p.user_id !== userId);
  s.user_preferences = s.user_preferences.filter((p) => p.owner_id !== userId);
  s.course_drafts = s.course_drafts.filter((d) => d.owner_id !== userId);
  s.sessions = s.sessions.filter((x) => x.owner_id !== userId);
  s.activity_drafts = s.activity_drafts.filter((d) => d.owner_id !== userId);
  s.attempts = s.attempts.filter((a) => a.owner_id !== userId);
  s.review_items = s.review_items.filter((r) => r.owner_id !== userId);
  s.notification_log = s.notification_log.filter((n) => n.owner_id !== userId);
  s.model_usage = s.model_usage.filter((m) => m.owner_id !== userId);
  s.telemetry_events = s.telemetry_events.filter((t) => t.owner_id !== userId);
  s.email_tokens = s.email_tokens.filter((t) => t.user_id !== userId);
}

function executeQuery(rawSql: string, params: unknown[]): unknown[] & { count: number } {
  const s = getStore();
  const now = new Date();
  const q = rawSql.replace(/\s+/g, " ").trim().toLowerCase();

  // ---------------- users & auth ----------------
  if (q.startsWith("insert into users (email, password_hash)")) {
    const email = String(params[0]);
    const passwordHash = String(params[1]);
    if (s.users.some((u) => u.email?.toLowerCase() === email.toLowerCase())) throw duplicateKeyError();
    const u: UserRecord = { id: randomUUID(), email, password_hash: passwordHash, is_guest: false, guest_ip_hash: null, email_verified_at: null, created_at: now };
    s.users.push(u);
    return resultWithCount([{ id: u.id, email: u.email }]);
  }

  if (q.startsWith("insert into users (is_guest, guest_ip_hash)")) {
    const ipHash = (params[0] as string | null) ?? null;
    const u: UserRecord = { id: randomUUID(), email: null, password_hash: null, is_guest: true, guest_ip_hash: ipHash, email_verified_at: null, created_at: now };
    s.users.push(u);
    return resultWithCount([{ id: u.id }]);
  }

  if (q.startsWith("select count(*)::int as n from users where is_guest and guest_ip_hash =")) {
    const ipHash = params[0] as string | null;
    const cutoff = now.getTime() - 3_600_000;
    const n = s.users.filter((u) => u.is_guest && u.guest_ip_hash === ipHash && u.created_at.getTime() > cutoff).length;
    return resultWithCount([{ n }]);
  }

  if (q.startsWith("delete from users u where u.id in")) {
    const cutoff = now.getTime() - 86_400_000;
    const stale = s.users
      .filter((g) => g.is_guest && g.created_at.getTime() < cutoff && !s.auth_sessions.some((sess) => sess.user_id === g.id && sess.expires_at > now))
      .slice(0, 200);
    for (const g of stale) cascadeDeleteUser(s, g.id);
    return resultWithCount([], stale.length);
  }

  if (q.startsWith("update users set email =") && q.includes("is_guest = false")) {
    const email = String(params[0]);
    const passwordHash = String(params[1]);
    const guestId = String(params[2]);
    if (s.users.some((u) => u.id !== guestId && u.email?.toLowerCase() === email.toLowerCase())) throw duplicateKeyError();
    const u = s.users.find((x) => x.id === guestId && x.is_guest);
    if (!u) return resultWithCount([]);
    u.email = email;
    u.password_hash = passwordHash;
    u.is_guest = false;
    u.guest_ip_hash = null;
    return resultWithCount([{ id: u.id, email: u.email, is_guest: false, display_name: null, timezone: null }]);
  }

  if (q.startsWith("select id from users where id =") && q.includes("and is_guest")) {
    const id = String(params[0]);
    const u = s.users.find((x) => x.id === id && x.is_guest);
    return resultWithCount(u ? [{ id: u.id }] : []);
  }

  if (q.startsWith("delete from users where id =")) {
    const id = String(params[0]);
    const existed = s.users.some((u) => u.id === id);
    if (existed) cascadeDeleteUser(s, id);
    return resultWithCount([], existed ? 1 : 0);
  }

  if (q.startsWith("select id, password_hash from users where email =")) {
    const email = String(params[0]).toLowerCase();
    const u = s.users.find((x) => !x.is_guest && x.email?.toLowerCase() === email);
    return resultWithCount(u ? [{ id: u.id, password_hash: u.password_hash }] : []);
  }

  if (q.startsWith("select id, email from users where email =") && q.includes("and not is_guest")) {
    const email = String(params[0]).toLowerCase();
    const u = s.users.find((x) => !x.is_guest && x.email?.toLowerCase() === email);
    return resultWithCount(u && u.email ? [{ id: u.id, email: u.email }] : []);
  }

  if (q.startsWith("select email, email_verified_at is not null as verified from users where id =")) {
    const id = String(params[0]);
    const u = s.users.find((x) => x.id === id && !x.is_guest);
    return resultWithCount(u ? [{ email: u.email, verified: u.email_verified_at !== null }] : []);
  }

  if (q.startsWith("update users set password_hash =") && q.includes("email_verified_at")) {
    const passwordHash = String(params[0]);
    const id = String(params[1]);
    const u = s.users.find((x) => x.id === id);
    if (u) {
      u.password_hash = passwordHash;
      u.email_verified_at = u.email_verified_at ?? now;
    }
    return resultWithCount([], u ? 1 : 0);
  }

  if (q.startsWith("update users set email_verified_at =")) {
    const id = String(params[0]);
    const u = s.users.find((x) => x.id === id);
    if (u) u.email_verified_at = u.email_verified_at ?? now;
    return resultWithCount([], u ? 1 : 0);
  }

  if (q.startsWith("select u.id, u.email, u.is_guest, p.display_name, p.timezone from users u left join profiles p")) {
    const id = String(params[0]);
    const u = s.users.find((x) => x.id === id);
    if (!u) return resultWithCount([]);
    const p = s.profiles.find((x) => x.user_id === u.id);
    return resultWithCount([{ id: u.id, email: u.email, is_guest: u.is_guest, display_name: p?.display_name ?? null, timezone: p?.timezone ?? "UTC" }]);
  }

  if (q.startsWith("select is_guest from users where id =")) {
    const id = String(params[0]);
    const u = s.users.find((x) => x.id === id);
    return resultWithCount(u ? [{ is_guest: u.is_guest }] : []);
  }

  if (q.startsWith("select email, is_guest from users where id =")) {
    const id = String(params[0]);
    const u = s.users.find((x) => x.id === id);
    return resultWithCount(u ? [{ email: u.email, is_guest: u.is_guest }] : []);
  }

  if (q.startsWith("select u.email, u.created_at, p.display_name, p.timezone from users u join profiles p")) {
    const id = String(params[0]);
    const u = s.users.find((x) => x.id === id);
    const p = s.profiles.find((x) => x.user_id === id);
    if (!u || !p) return resultWithCount([]);
    return resultWithCount([{ email: u.email, created_at: u.created_at, display_name: p.display_name, timezone: p.timezone }]);
  }

  if (q.startsWith("select u.email, u.is_guest, u.email_verified_at is not null as verified, p.display_name")) {
    const id = String(params[0]);
    const u = s.users.find((x) => x.id === id);
    const p = s.profiles.find((x) => x.user_id === id);
    const pr = s.user_preferences.find((x) => x.owner_id === id);
    if (!u || !p || !pr) return resultWithCount([]);
    return resultWithCount([
      {
        email: u.email,
        is_guest: u.is_guest,
        verified: u.email_verified_at !== null,
        display_name: p.display_name,
        timezone: p.timezone,
        reminders_enabled: pr.reminders_enabled,
        email_opt_in: pr.email_opt_in,
        quiet_hours_json: structuredClone(pr.quiet_hours_json),
      },
    ]);
  }

  if (q.includes("from model_usage m where m.owner_id = u.id") && q.includes("from users u where u.id =")) {
    const ownerId = String(params[0]);
    const u = s.users.find((x) => x.id === ownerId);
    if (!u) return resultWithCount([]);
    const minCut = now.getTime() - 60_000;
    const dayCut = now.getTime() - 86_400_000;
    const usage = s.model_usage.filter((m) => m.owner_id === ownerId);
    return resultWithCount([
      {
        minute: usage.filter((m) => m.created_at.getTime() > minCut).length,
        day: usage.filter((m) => m.created_at.getTime() > dayCut).length,
        is_guest: u.is_guest,
      },
    ]);
  }

  if (q.includes("from users u join profiles p on p.user_id = u.id join user_preferences pr on pr.owner_id = u.id where not u.is_guest")) {
    const refNow = asDate(params[0]);
    const recentMs = parseIntervalMs(String(params[2] ?? "2 hours"));
    const candidates = s.users
      .filter((u) => !u.is_guest && u.email !== null && u.email_verified_at !== null)
      .flatMap((u) => {
        const p = s.profiles.find((x) => x.user_id === u.id);
        const pr = s.user_preferences.find((x) => x.owner_id === u.id);
        if (!p || !pr || !pr.reminders_enabled || !pr.email_opt_in || pr.daily_nudge_limit <= 0) return [];
        const hasDue = s.review_items.some((r) => {
          const co = s.courses.find((c) => c.id === r.course_id);
          return r.owner_id === u.id && r.status === "active" && r.due_at <= refNow && co && co.status !== "archived";
        });
        if (!hasDue) return [];
        const studiedRecently = s.attempts.some((a) => a.owner_id === u.id && a.submitted_at.getTime() > refNow.getTime() - recentMs);
        if (studiedRecently) return [];
        const sentWeek = s.notification_log.filter((n) => n.owner_id === u.id && n.channel === "email" && n.created_at.getTime() > refNow.getTime() - 7 * 86_400_000).length;
        return [
          {
            id: u.id,
            email: u.email!,
            timezone: p.timezone,
            quiet_hours_json: structuredClone(pr.quiet_hours_json),
            daily_nudge_limit: pr.daily_nudge_limit,
            weekly_nudge_limit: pr.weekly_nudge_limit,
            unsubscribe_token: pr.unsubscribe_token,
            sent_week: sentWeek,
          },
        ];
      })
      .slice(0, 500);
    return resultWithCount(candidates);
  }

  // ---------------- profiles & preferences ----------------
  if (q.startsWith("insert into profiles (user_id, timezone)")) {
    s.profiles.push({ user_id: String(params[0]), display_name: null, timezone: String(params[1]), created_at: now, updated_at: now });
    return resultWithCount([], 1);
  }

  if (q.startsWith("select display_name, timezone from profiles where user_id =")) {
    const p = s.profiles.find((x) => x.user_id === String(params[0]));
    return resultWithCount(p ? [{ display_name: p.display_name, timezone: p.timezone }] : []);
  }

  if (q.startsWith("update profiles set display_name =")) {
    const p = s.profiles.find((x) => x.user_id === String(params[2]));
    if (p) {
      p.display_name = (params[0] as string | null) ?? null;
      p.timezone = String(params[1]);
      p.updated_at = now;
    }
    return resultWithCount([], p ? 1 : 0);
  }

  if (q.startsWith("insert into user_preferences (owner_id)")) {
    s.user_preferences.push({
      owner_id: String(params[0]),
      reminders_enabled: false,
      email_opt_in: false,
      quiet_hours_json: { start: "21:00", end: "08:00" },
      daily_nudge_limit: 1,
      weekly_nudge_limit: 3,
      unsubscribe_token: (randomUUID() + randomUUID()).replace(/-/g, ""),
      updated_at: now,
    });
    return resultWithCount([], 1);
  }

  if (q.startsWith("select * from user_preferences where owner_id =")) {
    const pr = s.user_preferences.find((x) => x.owner_id === String(params[0]));
    return resultWithCount(pr ? [structuredClone(pr)] : []);
  }

  if (q.startsWith("update user_preferences set reminders_enabled =")) {
    const pr = s.user_preferences.find((x) => x.owner_id === String(params[3]));
    if (pr) {
      pr.reminders_enabled = Boolean(params[0]);
      pr.email_opt_in = Boolean(params[1]);
      pr.quiet_hours_json = unwrap(params[2]) as { start: string; end: string };
      pr.updated_at = now;
    }
    return resultWithCount([], pr ? 1 : 0);
  }

  if (q.startsWith("update user_preferences set email_opt_in = false where unsubscribe_token =")) {
    const pr = s.user_preferences.find((x) => x.unsubscribe_token === String(params[0]));
    if (pr) {
      pr.email_opt_in = false;
      pr.updated_at = now;
    }
    return resultWithCount([], pr ? 1 : 0);
  }

  // ---------------- auth_sessions, auth_attempts, email_tokens, work_claims ----------------
  if (q.startsWith("insert into auth_sessions (user_id, token_hash, expires_at)")) {
    s.auth_sessions.push({
      id: randomUUID(),
      user_id: String(params[0]),
      token_hash: String(params[1]),
      expires_at: asDate(params[2]),
      created_at: now,
    });
    return resultWithCount([], 1);
  }

  if (q.startsWith("delete from auth_sessions where token_hash =")) {
    const before = s.auth_sessions.length;
    s.auth_sessions = s.auth_sessions.filter((x) => x.token_hash !== String(params[0]));
    return resultWithCount([], before - s.auth_sessions.length);
  }

  if (q.startsWith("delete from auth_sessions where user_id =")) {
    const before = s.auth_sessions.length;
    s.auth_sessions = s.auth_sessions.filter((x) => x.user_id !== String(params[0]));
    return resultWithCount([], before - s.auth_sessions.length);
  }

  if (q.startsWith("delete from auth_sessions where expires_at <")) {
    const cutoff = now.getTime() - 86_400_000;
    const before = s.auth_sessions.length;
    s.auth_sessions = s.auth_sessions.filter((x) => x.expires_at.getTime() >= cutoff);
    return resultWithCount([], before - s.auth_sessions.length);
  }

  if (q.startsWith("update auth_sessions set expires_at =")) {
    const ms = parseIntervalMs(String(params[0]));
    const userId = String(params[1]);
    let count = 0;
    for (const sess of s.auth_sessions) {
      if (sess.user_id === userId) {
        sess.expires_at = new Date(now.getTime() + ms);
        count++;
      }
    }
    return resultWithCount([], count);
  }

  if (q.startsWith("select u.id, u.email, u.is_guest, p.display_name, p.timezone from auth_sessions s")) {
    const tokenHash = String(params[0]);
    const sess = s.auth_sessions.find((x) => x.token_hash === tokenHash && x.expires_at > now);
    if (!sess) return resultWithCount([]);
    const u = s.users.find((x) => x.id === sess.user_id);
    if (!u) return resultWithCount([]);
    const p = s.profiles.find((x) => x.user_id === u.id);
    return resultWithCount([{ id: u.id, email: u.email, is_guest: u.is_guest, display_name: p?.display_name ?? null, timezone: p?.timezone ?? "UTC" }]);
  }

  if (q.includes("from auth_attempts where not ok")) {
    const emailHash = String(params[0]);
    const ipHash = params[1] as string | null;
    const cutoff = now.getTime() - 15 * 60_000;
    const recent = s.auth_attempts.filter((a) => !a.ok && a.created_at.getTime() > cutoff);
    const byEmail = recent.filter((a) => a.email_hash === emailHash).length;
    const byIp = ipHash ? recent.filter((a) => a.ip_hash === ipHash).length : 0;
    return resultWithCount([{ by_email: byEmail, by_ip: byIp }]);
  }

  if (q.startsWith("insert into auth_attempts (email_hash, ip_hash, ok)")) {
    s.auth_attempts.push({
      id: s.seq++,
      email_hash: String(params[0]),
      ip_hash: (params[1] as string | null) ?? null,
      ok: Boolean(params[2]),
      created_at: now,
    });
    return resultWithCount([], 1);
  }

  if (q.startsWith("delete from auth_attempts where created_at <")) {
    const cutoff = now.getTime() - 86_400_000;
    const before = s.auth_attempts.length;
    s.auth_attempts = s.auth_attempts.filter((a) => a.created_at.getTime() >= cutoff);
    return resultWithCount([], before - s.auth_attempts.length);
  }

  if (q.startsWith("insert into work_claims (resource, token, expires_at)")) {
    const resource = String(params[0]);
    const token = String(params[1]);
    const ttlMs = parseIntervalMs(String(params[2]));
    const expiresAt = new Date(now.getTime() + ttlMs);
    const existing = s.work_claims.find((c) => c.resource === resource);
    if (!existing) {
      s.work_claims.push({ resource, token, expires_at: expiresAt, created_at: now });
      return resultWithCount([{ token }]);
    }
    if (existing.expires_at < now) {
      existing.token = token;
      existing.expires_at = expiresAt;
      existing.created_at = now;
      return resultWithCount([{ token }]);
    }
    return resultWithCount([]);
  }

  if (q.startsWith("delete from work_claims where resource =")) {
    const resource = String(params[0]);
    const token = String(params[1]);
    const before = s.work_claims.length;
    s.work_claims = s.work_claims.filter((c) => !(c.resource === resource && c.token === token));
    return resultWithCount([], before - s.work_claims.length);
  }

  if (q.startsWith("delete from work_claims where expires_at <")) {
    const cutoff = now.getTime() - 3_600_000;
    const before = s.work_claims.length;
    s.work_claims = s.work_claims.filter((c) => c.expires_at.getTime() >= cutoff);
    return resultWithCount([], before - s.work_claims.length);
  }

  if (q.startsWith("select count(*)::int as n from email_tokens where user_id =")) {
    const userId = String(params[0]);
    const purpose = String(params[1]);
    const cutoff = now.getTime() - 3_600_000;
    const n = s.email_tokens.filter((t) => t.user_id === userId && t.purpose === purpose && t.created_at.getTime() > cutoff).length;
    return resultWithCount([{ n }]);
  }

  if (q.startsWith("insert into email_tokens (user_id, purpose, token_hash, expires_at)")) {
    const ttlMs = parseIntervalMs(String(params[3]));
    s.email_tokens.push({
      id: randomUUID(),
      user_id: String(params[0]),
      purpose: String(params[1]),
      token_hash: String(params[2]),
      expires_at: new Date(now.getTime() + ttlMs),
      used_at: null,
      created_at: now,
    });
    return resultWithCount([], 1);
  }

  if (q.startsWith("select id, user_id from email_tokens where token_hash =")) {
    const tokenHash = String(params[0]);
    const purpose = q.includes("purpose = 'reset'") ? "reset" : "verify";
    const row = s.email_tokens.find((t) => t.token_hash === tokenHash && t.purpose === purpose && t.used_at === null && t.expires_at > now);
    return resultWithCount(row ? [{ id: row.id, user_id: row.user_id }] : []);
  }

  if (q.startsWith("update email_tokens set used_at = now() where user_id =")) {
    const userId = String(params[0]);
    const purpose = q.includes("purpose = 'reset'") ? "reset" : "verify";
    let count = 0;
    for (const t of s.email_tokens) {
      if (t.user_id === userId && t.purpose === purpose && t.used_at === null) {
        t.used_at = now;
        count++;
      }
    }
    return resultWithCount([], count);
  }

  if (q.startsWith("delete from email_tokens where expires_at <")) {
    const cutoff = now.getTime() - 86_400_000;
    const before = s.email_tokens.length;
    s.email_tokens = s.email_tokens.filter((t) => t.expires_at.getTime() >= cutoff);
    return resultWithCount([], before - s.email_tokens.length);
  }

  // ---------------- model_usage, telemetry_events, notification_log ----------------
  if (q.startsWith("insert into model_usage")) {
    if (q.includes("error_code")) {
      s.model_usage.push({
        id: s.seq++,
        owner_id: (params[0] as string | null) ?? null,
        operation: String(params[1]),
        provider: String(params[2]),
        model: "unknown",
        ok: false,
        latency_ms: Number(params[3] ?? 0),
        input_tokens: null,
        output_tokens: null,
        error_code: String(params[4] ?? "internal"),
        created_at: now,
      });
    } else {
      s.model_usage.push({
        id: s.seq++,
        owner_id: (params[0] as string | null) ?? null,
        operation: String(params[1]),
        provider: String(params[2]),
        model: String(params[3]),
        ok: true,
        latency_ms: Number(params[4] ?? 0),
        input_tokens: (params[5] as number | null) ?? null,
        output_tokens: (params[6] as number | null) ?? null,
        error_code: null,
        created_at: now,
      });
    }
    return resultWithCount([], 1);
  }

  if (q.startsWith("insert into telemetry_events")) {
    s.telemetry_events.push({
      id: s.seq++,
      owner_id: (params[0] as string | null) ?? null,
      event_type: String(params[1]),
      props_json: (unwrap(params[2]) as Record<string, unknown>) ?? {},
      created_at: now,
    });
    return resultWithCount([], 1);
  }

  if (q.startsWith("insert into notification_log")) {
    const ownerId = String(params[0]);
    const key = String(params[1]);
    if (s.notification_log.some((n) => n.owner_id === ownerId && n.idempotency_key === key)) return resultWithCount([]);
    const n: NotificationLogRecord = {
      id: randomUUID(),
      owner_id: ownerId,
      course_id: null,
      channel: "email",
      status: "sending",
      idempotency_key: key,
      payload_json: {},
      created_at: now,
      sent_at: null,
    };
    s.notification_log.push(n);
    return resultWithCount([{ id: n.id }]);
  }

  if (q.startsWith("update notification_log set status = 'sent'")) {
    const n = s.notification_log.find((x) => x.id === String(params[1]));
    if (n) {
      n.status = "sent";
      n.sent_at = now;
      n.payload_json = (unwrap(params[0]) as Record<string, unknown>) ?? {};
    }
    return resultWithCount([], n ? 1 : 0);
  }

  if (q.startsWith("delete from notification_log where id =")) {
    const before = s.notification_log.length;
    s.notification_log = s.notification_log.filter((x) => x.id !== String(params[0]));
    return resultWithCount([], before - s.notification_log.length);
  }

  // ---------------- course_drafts ----------------
  if (q.startsWith("select * from course_drafts where id =") && q.includes("and owner_id =")) {
    const d = s.course_drafts.find((x) => x.id === String(params[0]) && x.owner_id === String(params[1]));
    return resultWithCount(d ? [structuredClone(d)] : []);
  }

  if (q.startsWith("select id from course_drafts where owner_id =") && q.includes("and idempotency_key =")) {
    const d = s.course_drafts.find((x) => x.owner_id === String(params[0]) && x.idempotency_key === String(params[1]));
    return resultWithCount(d ? [{ id: d.id }] : []);
  }

  if (q.startsWith("insert into course_drafts (owner_id, topic, idempotency_key, state_json)")) {
    const ownerId = String(params[0]);
    const topic = String(params[1]);
    const key = String(params[2]);
    if (s.course_drafts.some((x) => x.owner_id === ownerId && x.idempotency_key === key)) return resultWithCount([]);
    const d: CourseDraftRecord = {
      id: randomUUID(),
      owner_id: ownerId,
      topic,
      state_json: (unwrap(params[3]) as Record<string, unknown>) ?? {},
      turns_json: [],
      status: "collecting",
      proposal_json: null,
      version: 1,
      idempotency_key: key,
      converted_course_id: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    s.course_drafts.push(d);
    return resultWithCount([{ id: d.id }]);
  }

  if (q.startsWith("update course_drafts set state_json =")) {
    const d = s.course_drafts.find((x) => x.id === String(params[5]));
    if (!d) return resultWithCount([]);
    d.state_json = (unwrap(params[0]) as Record<string, unknown>) ?? {};
    d.turns_json = (unwrap(params[1]) as unknown[]) ?? [];
    d.status = params[2] as CourseDraftRecord["status"];
    d.proposal_json = unwrap(params[3]);
    d.last_error = (params[4] as string | null) ?? null;
    d.version += 1;
    d.updated_at = now;
    return resultWithCount([structuredClone(d)]);
  }

  if (q.startsWith("update course_drafts set status = 'converted'")) {
    const d = s.course_drafts.find((x) => x.id === String(params[1]));
    if (d) {
      d.status = "converted";
      d.converted_course_id = String(params[0]);
      d.version += 1;
      d.updated_at = now;
    }
    return resultWithCount([], d ? 1 : 0);
  }

  if (q.startsWith("select id, topic, updated_at from course_drafts where owner_id =")) {
    const ownerId = String(params[0]);
    const cutoff = now.getTime() - 14 * 86_400_000;
    const rows = s.course_drafts
      .filter((d) => d.owner_id === ownerId && d.status !== "converted" && d.updated_at.getTime() > cutoff)
      .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
      .slice(0, 1)
      .map((d) => ({ id: d.id, topic: d.topic, updated_at: d.updated_at }));
    return resultWithCount(rows);
  }

  if (q.startsWith("select id, topic, status, state_json, proposal_json, created_at from course_drafts where owner_id =")) {
    const ownerId = String(params[0]);
    const rows = s.course_drafts
      .filter((d) => d.owner_id === ownerId)
      .map((d) => ({ id: d.id, topic: d.topic, status: d.status, state_json: structuredClone(d.state_json), proposal_json: structuredClone(d.proposal_json), created_at: d.created_at }));
    return resultWithCount(rows);
  }

  // ---------------- courses, goals, concepts, curriculum ----------------
  if (q.startsWith("select count(*)::int as n from courses where owner_id =")) {
    const n = s.courses.filter((c) => c.owner_id === String(params[0])).length;
    return resultWithCount([{ n }]);
  }

  if (q.startsWith("insert into courses (owner_id, draft_id, title, topic, intent)")) {
    const c: CourseRecord = {
      id: randomUUID(),
      owner_id: String(params[0]),
      draft_id: (params[1] as string | null) ?? null,
      title: String(params[2]),
      topic: String(params[3]),
      intent: params[4] as "curiosity" | "goal",
      status: "active",
      active_goal_version_id: null,
      version: 1,
      created_at: now,
      updated_at: now,
      last_opened_at: now,
    };
    s.courses.push(c);
    return resultWithCount([{ id: c.id }]);
  }

  if (q.startsWith("update courses set active_goal_version_id =") && q.includes("intent =")) {
    const c = s.courses.find((x) => x.id === String(params[2]));
    if (c) {
      c.active_goal_version_id = String(params[0]);
      c.intent = params[1] as "curiosity" | "goal";
      c.version += 1;
      c.updated_at = now;
    }
    return resultWithCount([], c ? 1 : 0);
  }

  if (q.startsWith("update courses set active_goal_version_id =")) {
    const c = s.courses.find((x) => x.id === String(params[1]));
    if (c) {
      c.active_goal_version_id = String(params[0]);
      c.updated_at = now;
    }
    return resultWithCount([], c ? 1 : 0);
  }

  if (q.startsWith("update courses set last_opened_at = now() where id =")) {
    const c = s.courses.find((x) => x.id === String(params[0]));
    if (c) c.last_opened_at = now;
    return resultWithCount([], c ? 1 : 0);
  }

  if (q.startsWith("update courses set title =")) {
    const c = s.courses.find((x) => x.id === String(params[2]));
    if (c) {
      c.title = String(params[0]);
      c.status = params[1] as CourseRecord["status"];
      c.version += 1;
      c.updated_at = now;
    }
    return resultWithCount([], c ? 1 : 0);
  }

  if (q.startsWith("delete from courses where id =")) {
    const courseId = String(params[0]);
    const ownerId = String(params[1]);
    const exists = s.courses.some((c) => c.id === courseId && c.owner_id === ownerId);
    if (exists) cascadeDeleteCourse(s, courseId);
    return resultWithCount([], exists ? 1 : 0);
  }

  if (q.startsWith("select * from courses where id =") && q.includes("and owner_id =")) {
    const c = s.courses.find((x) => x.id === String(params[0]) && x.owner_id === String(params[1]));
    return resultWithCount(c ? [structuredClone(c)] : []);
  }

  if (q.startsWith("select * from courses where owner_id =")) {
    const rows = s.courses.filter((x) => x.owner_id === String(params[0])).map((x) => structuredClone(x));
    return resultWithCount(rows);
  }

  if (q.startsWith("select c.id, c.title, c.intent, greatest(c.updated_at, c.last_opened_at) as updated_at")) {
    const ownerId = String(params[0]);
    const rows = s.courses
      .filter((c) => c.owner_id === ownerId && c.status !== "archived")
      .sort((a, b) => b.last_opened_at.getTime() - a.last_opened_at.getTime())
      .slice(0, 200)
      .map((c) => {
        const updated = c.updated_at > c.last_opened_at ? c.updated_at : c.last_opened_at;
        const due = s.review_items.filter((r) => r.course_id === c.id && r.status === "active" && r.due_at <= now).length;
        const open = s.sessions.find((sess) => sess.course_id === c.id && (sess.status === "active" || sess.status === "paused"));
        return { id: c.id, title: c.title, intent: c.intent, updated_at: updated, due, open_kind: open?.kind ?? null };
      });
    return resultWithCount(rows);
  }

  if (q.startsWith("insert into course_goal_versions")) {
    const g: CourseGoalVersionRecord = {
      id: randomUUID(),
      course_id: String(params[0]),
      version: q.includes("values ($0, 1,") ? 1 : Number(params[1]),
      intent: (q.includes("values ($0, 1,") ? params[1] : params[2]) as "curiosity" | "goal",
      goal_text: String(q.includes("values ($0, 1,") ? params[2] : params[3]),
      success_criteria_json: (unwrap(q.includes("values ($0, 1,") ? params[3] : params[4]) as string[]) ?? [],
      time_budget_minutes_weekly: ((q.includes("values ($0, 1,") ? params[4] : params[5]) as number | null) ?? null,
      baseline_json: (unwrap(q.includes("values ($0, 1,") ? params[5] : params[6]) as Record<string, unknown>) ?? {},
      depth: ((q.includes("values ($0, 1,") ? params[6] : params[7]) as string | null) ?? null,
      deadline_at: null,
      reason: q.includes("values ($0, 1,") ? "initial" : ((params[8] as string | null) ?? null),
      created_at: now,
    };
    s.course_goal_versions.push(g);
    return resultWithCount([{ id: g.id }]);
  }

  if (q.startsWith("select * from course_goal_versions where course_id =") && q.includes("order by (id =")) {
    const courseId = String(params[0]);
    const activeId = params[1] as string | null;
    const rows = s.course_goal_versions
      .filter((g) => g.course_id === courseId)
      .sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId) || b.version - a.version);
    return resultWithCount(rows[0] ? [structuredClone(rows[0])] : []);
  }

  if (q.startsWith("select version, goal_text, reason, created_at from course_goal_versions where course_id =")) {
    const rows = s.course_goal_versions
      .filter((g) => g.course_id === String(params[0]))
      .sort((a, b) => b.version - a.version)
      .map((g) => ({ version: g.version, goal_text: g.goal_text, reason: g.reason, created_at: g.created_at }));
    return resultWithCount(rows);
  }

  if (q.startsWith("select coalesce(max(version), 0)::int as v from course_goal_versions where course_id =")) {
    const versions = s.course_goal_versions.filter((g) => g.course_id === String(params[0])).map((g) => g.version);
    return resultWithCount([{ v: versions.length ? Math.max(...versions) : 0 }]);
  }

  if (q.startsWith("insert into concepts")) {
    const c: ConceptRecord = {
      id: randomUUID(),
      course_id: String(params[0]),
      slug: String(params[1]),
      title: String(params[2]),
      description: String(params[3]),
      assessment_criteria_json: (unwrap(params[4]) as string[]) ?? [],
      importance: Number(params[5]),
      position: Number(params[6]),
      origin: params[7] as ConceptRecord["origin"],
      status: "active",
      created_at: now,
    };
    s.concepts.push(c);
    return resultWithCount([{ id: c.id }]);
  }

  if (q.includes('max(position), 0)::int as "maxpos" from concepts where course_id =')) {
    const positions = s.concepts.filter((c) => c.course_id === String(params[0])).map((c) => c.position);
    return resultWithCount([{ maxPos: positions.length ? Math.max(...positions) : 0 }]);
  }

  if (q.startsWith("select 1 from concepts where id =")) {
    const exists = s.concepts.some((c) => c.id === String(params[0]) && c.course_id === String(params[1]));
    return resultWithCount(exists ? [{ "?column?": 1 }] : []);
  }

  if (q.startsWith("select c.id, c.slug, c.title, c.description, c.assessment_criteria_json, c.importance, c.position, c.origin, m.status")) {
    const courseId = String(params[0]);
    const rows = s.concepts
      .filter((c) => c.course_id === courseId && c.status === "active")
      .sort((a, b) => a.position - b.position)
      .map((c) => {
        const m = s.mastery_estimates.find((x) => x.concept_id === c.id);
        const r = s.review_items.find((x) => x.concept_id === c.id && x.status === "active");
        return {
          id: c.id,
          slug: c.slug,
          title: c.title,
          description: c.description,
          assessment_criteria_json: structuredClone(c.assessment_criteria_json),
          importance: c.importance,
          position: c.position,
          origin: c.origin,
          status: m?.status ?? null,
          details_json: m ? structuredClone(m.details_json) : null,
          due_at: r?.due_at ?? null,
          review_item_id: r?.id ?? null,
        };
      });
    return resultWithCount(rows);
  }

  if (q.startsWith("select c.slug, c.title, c.description, c.assessment_criteria_json, co.topic, g.baseline_json->>'text' as baseline")) {
    const c = s.concepts.find((x) => x.id === String(params[0]));
    if (!c) return resultWithCount([]);
    const co = s.courses.find((x) => x.id === c.course_id);
    if (!co) return resultWithCount([]);
    const g = s.course_goal_versions.find((x) => x.id === co.active_goal_version_id);
    const baseline = typeof g?.baseline_json?.text === "string" ? g.baseline_json.text : null;
    return resultWithCount([
      {
        slug: c.slug,
        title: c.title,
        description: c.description,
        assessment_criteria_json: structuredClone(c.assessment_criteria_json),
        topic: co.topic,
        baseline,
      },
    ]);
  }

  if (q.startsWith("select c.slug, c.title, c.description, c.assessment_criteria_json, co.topic from concepts c join courses co")) {
    const c = s.concepts.find((x) => x.id === String(params[0]));
    if (!c) return resultWithCount([]);
    const co = s.courses.find((x) => x.id === c.course_id);
    if (!co) return resultWithCount([]);
    return resultWithCount([
      {
        slug: c.slug,
        title: c.title,
        description: c.description,
        assessment_criteria_json: structuredClone(c.assessment_criteria_json),
        topic: co.topic,
      },
    ]);
  }

  if (q.startsWith("insert into concept_edges")) {
    const courseId = String(params[0]);
    const fromId = String(params[1]);
    const toId = String(params[2]);
    const edgeType: ConceptEdgeRecord["edge_type"] = q.includes("'related'") ? "related" : "prerequisite";
    if (!s.concept_edges.some((e) => e.course_id === courseId && e.from_concept_id === fromId && e.to_concept_id === toId && e.edge_type === edgeType)) {
      s.concept_edges.push({ course_id: courseId, from_concept_id: fromId, to_concept_id: toId, edge_type: edgeType });
    }
    return resultWithCount([], 1);
  }

  if (q.startsWith("select from_concept_id, to_concept_id from concept_edges where course_id =")) {
    const edgeType = q.includes("'related'") ? "related" : "prerequisite";
    const rows = s.concept_edges
      .filter((e) => e.course_id === String(params[0]) && e.edge_type === edgeType)
      .map((e) => ({ from_concept_id: e.from_concept_id, to_concept_id: e.to_concept_id }));
    return resultWithCount(rows);
  }

  if (q.startsWith("insert into course_curriculum_versions")) {
    const isInitial = q.includes("values ($0, 1,");
    const reason = q.includes("'goal_revised'") ? "goal_revised" : q.includes("'branch'") ? "branch" : q.includes("'scaffold'") ? "scaffold" : "initial";
    s.course_curriculum_versions.push({
      id: randomUUID(),
      course_id: String(params[0]),
      version: isInitial ? 1 : Number(params[1]),
      plan_json: (unwrap(isInitial ? params[1] : params[2]) as Record<string, unknown>) ?? {},
      reason,
      model_info_json: (unwrap(isInitial ? params[2] : params[3]) as Record<string, unknown>) ?? {},
      created_at: now,
    });
    return resultWithCount([], 1);
  }

  if (q.startsWith("select version, plan_json, reason from course_curriculum_versions where course_id =")) {
    const rows = s.course_curriculum_versions
      .filter((v) => v.course_id === String(params[0]))
      .sort((a, b) => b.version - a.version);
    return resultWithCount(rows[0] ? [{ version: rows[0].version, plan_json: structuredClone(rows[0].plan_json), reason: rows[0].reason }] : []);
  }

  if (q.startsWith("insert into course_events")) {
    const courseId = String(params[0]);
    const literalMatch = rawSql.match(/values\s*\([^,]+,\s*'([^']+)'/i);
    const eventType = literalMatch ? literalMatch[1] : String(params[1]);
    const payload = unwrap(literalMatch ? params[1] : params[2]) as Record<string, unknown>;
    s.course_events.push({ id: randomUUID(), course_id: courseId, event_type: eventType, payload_json: payload ?? {}, created_at: now });
    return resultWithCount([], 1);
  }

  if (q.includes("from course_events e") && q.includes("e.event_type = 'final_assessment'")) {
    const courseId = String(params[0]);
    const cvDates = s.course_curriculum_versions.filter((v) => v.course_id === courseId).map((v) => v.created_at.getTime());
    const minTs = cvDates.length ? Math.max(...cvDates) : -Infinity;
    const passed = s.course_events.some(
      (e) => e.course_id === courseId && e.event_type === "final_assessment" && Boolean(e.payload_json?.passed) && e.created_at.getTime() >= minTs,
    );
    return resultWithCount([{ passed }]);
  }

  if (q.startsWith("insert into source_references")) {
    if (q.includes("activity_id")) {
      s.source_references.push({
        id: randomUUID(),
        course_id: String(params[0]),
        activity_id: String(params[1]),
        title: String(params[2]),
        url: String(params[3]),
        retrieved_at: asDate(params[4]),
        source_type: "web_search",
      });
    } else {
      s.source_references.push({
        id: randomUUID(),
        course_id: String(params[0]),
        activity_id: null,
        title: String(params[1]),
        url: String(params[2]),
        retrieved_at: asDate(params[3]),
        source_type: "learner_link",
      });
    }
    return resultWithCount([], 1);
  }

  if (q.startsWith("select activity_id, title, url from source_references where course_id =")) {
    const courseId = String(params[0]);
    const rows = s.source_references
      .filter((r) => r.course_id === courseId && r.activity_id !== null)
      .sort((a, b) => a.retrieved_at.getTime() - b.retrieved_at.getTime())
      .map((r) => ({ activity_id: r.activity_id!, title: r.title, url: r.url }));
    return resultWithCount(rows);
  }

  // ---------------- sessions & activities ----------------
  if (q.startsWith("select id, kind, status from sessions where course_id =")) {
    const open = s.sessions.find((x) => x.course_id === String(params[0]) && (x.status === "active" || x.status === "paused"));
    return resultWithCount(open ? [{ id: open.id, kind: open.kind, status: open.status }] : []);
  }

  if (q.startsWith("select kind from sessions where course_id =")) {
    const open = s.sessions.find((x) => x.course_id === String(params[0]) && (x.status === "active" || x.status === "paused"));
    return resultWithCount(open ? [{ kind: open.kind }] : []);
  }

  if (q.startsWith("select * from sessions where course_id =") && q.includes("status in ('active','paused')")) {
    const open = s.sessions.find((x) => x.course_id === String(params[0]) && (x.status === "active" || x.status === "paused"));
    return resultWithCount(open ? [structuredClone(open)] : []);
  }

  if (q.startsWith("select * from sessions where id =") && q.includes("and owner_id =")) {
    const sess = s.sessions.find((x) => x.id === String(params[0]) && x.owner_id === String(params[1]));
    return resultWithCount(sess ? [structuredClone(sess)] : []);
  }

  if (q.startsWith("select * from sessions where owner_id =")) {
    return resultWithCount(s.sessions.filter((x) => x.owner_id === String(params[0])).map((x) => structuredClone(x)));
  }

  if (q.startsWith("insert into sessions (course_id, owner_id, kind, checkpoint_json)")) {
    const sess: SessionRecord = {
      id: randomUUID(),
      course_id: String(params[0]),
      owner_id: String(params[1]),
      kind: String(params[2]),
      status: "active",
      started_at: now,
      ended_at: null,
      current_activity_id: null,
      checkpoint_json: (unwrap(params[3]) as Record<string, unknown>) ?? {},
      idempotency_key: null,
      version: 1,
    };
    s.sessions.push(sess);
    return resultWithCount([{ id: sess.id }]);
  }

  if (q.startsWith("update sessions set status = 'active', checkpoint_json =")) {
    const sess = s.sessions.find((x) => x.id === String(params[1]));
    if (sess) {
      sess.status = "active";
      sess.checkpoint_json = (unwrap(params[0]) as Record<string, unknown>) ?? {};
      sess.version += 1;
    }
    return resultWithCount([], sess ? 1 : 0);
  }

  if (q.startsWith("update sessions set status = 'active' where id =")) {
    const sess = s.sessions.find((x) => x.id === String(params[0]));
    if (sess) sess.status = "active";
    return resultWithCount([], sess ? 1 : 0);
  }

  if (q.startsWith("update sessions set status = 'paused', checkpoint_json =")) {
    const sess = s.sessions.find((x) => x.id === String(params[1]));
    if (sess) {
      sess.status = "paused";
      sess.checkpoint_json = (unwrap(params[0]) as Record<string, unknown>) ?? {};
      sess.version += 1;
    }
    return resultWithCount([], sess ? 1 : 0);
  }

  if (q.startsWith("update sessions set status = 'completed', ended_at = now(), checkpoint_json =")) {
    const sess = s.sessions.find((x) => x.id === String(params[1]));
    if (sess) {
      sess.status = "completed";
      sess.ended_at = now;
      sess.checkpoint_json = (unwrap(params[0]) as Record<string, unknown>) ?? {};
      sess.version += 1;
    }
    return resultWithCount([], sess ? 1 : 0);
  }

  if (q.startsWith("update sessions set status = 'completed', ended_at = now() where id =")) {
    const sess = s.sessions.find((x) => x.id === String(params[0]));
    if (sess) {
      sess.status = "completed";
      sess.ended_at = now;
    }
    return resultWithCount([], sess ? 1 : 0);
  }

  if (q.startsWith("update sessions set current_activity_id =")) {
    const sess = s.sessions.find((x) => x.id === String(params[1]));
    if (sess) {
      sess.current_activity_id = (params[0] as string | null) ?? null;
      sess.version += 1;
    }
    return resultWithCount([], sess ? 1 : 0);
  }

  if (q.startsWith("update sessions set checkpoint_json =")) {
    const sess = s.sessions.find((x) => x.id === String(params[1]));
    if (sess) {
      sess.checkpoint_json = (unwrap(params[0]) as Record<string, unknown>) ?? {};
      sess.version += 1;
    }
    return resultWithCount([], sess ? 1 : 0);
  }

  if (q.startsWith("select (select count(*)::int from sessions where course_id =")) {
    const courseId = String(params[0]);
    return resultWithCount([
      {
        sessions: s.sessions.filter((x) => x.course_id === courseId).length,
        activities: s.activities.filter((x) => x.course_id === courseId).length,
      },
    ]);
  }

  if (q.startsWith("insert into activities")) {
    const a: ActivityRecord = {
      id: randomUUID(),
      session_id: String(params[0]),
      course_id: String(params[1]),
      concept_id: String(params[2]),
      review_item_id: (params[3] as string | null) ?? null,
      sequence_no: Number(params[4]),
      kind: String(params[5]),
      purpose: String(params[6]),
      spec_json: (unwrap(params[7]) as Record<string, unknown>) ?? {},
      status: "presented",
      hints_json: [],
      alt_explanations_json: [],
      model_info_json: (unwrap(params[8]) as Record<string, unknown>) ?? {},
      created_at: now,
    };
    s.activities.push(a);
    return resultWithCount([{ id: a.id }]);
  }

  if (q.startsWith("select * from activities where id =")) {
    const a = s.activities.find((x) => x.id === String(params[0]));
    return resultWithCount(a ? [structuredClone(a)] : []);
  }

  if (q.startsWith("select a.*, c.title as concept_title from activities a join concepts c")) {
    const a = s.activities.find((x) => x.id === String(params[0]));
    if (!a) return resultWithCount([]);
    const c = s.concepts.find((x) => x.id === a.concept_id);
    return resultWithCount([{ ...structuredClone(a), concept_title: c?.title ?? "" }]);
  }

  if (q.startsWith("select a.*, s.owner_id, s.status as session_status, s.kind as session_kind from activities a join sessions s")) {
    const a = s.activities.find((x) => x.id === String(params[0]));
    if (!a) return resultWithCount([]);
    const sess = s.sessions.find((x) => x.id === a.session_id && x.owner_id === String(params[1]));
    if (!sess) return resultWithCount([]);
    return resultWithCount([{ ...structuredClone(a), owner_id: sess.owner_id, session_status: sess.status, session_kind: sess.kind }]);
  }

  if (q.startsWith("select a.id as activity_id, a.concept_id, a.kind, a.purpose, e.result from activities a")) {
    const rows = s.activities
      .filter((a) => a.session_id === String(params[0]))
      .sort((a, b) => a.sequence_no - b.sequence_no)
      .map((a) => {
        const at = s.attempts.find((x) => x.activity_id === a.id);
        const ev = at ? s.assessment_evidence.find((x) => x.attempt_id === at.id) : undefined;
        return { activity_id: a.id, concept_id: a.concept_id, kind: a.kind, purpose: a.purpose, result: ev?.result ?? null };
      });
    return resultWithCount(rows);
  }

  if (q.startsWith("select id, concept_id, spec_json, alt_explanations_json, model_info_json, created_at from activities where course_id =")) {
    const courseId = String(params[0]);
    const rows = s.activities
      .filter((a) => a.course_id === courseId && a.kind === "explanation")
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map((a) => ({
        id: a.id,
        concept_id: a.concept_id,
        spec_json: structuredClone(a.spec_json),
        alt_explanations_json: structuredClone(a.alt_explanations_json),
        model_info_json: structuredClone(a.model_info_json),
        created_at: a.created_at,
      }));
    return resultWithCount(rows);
  }

  if (q.startsWith("select concept_id from activities where session_id =") && q.includes("and sequence_no >=")) {
    const sessionId = String(params[0]);
    const minSeq = Number(params[1]);
    const maxSeq = Number(params[2]);
    const rows = s.activities
      .filter((x) => x.session_id === sessionId && x.sequence_no >= minSeq && x.sequence_no < maxSeq)
      .map((x) => ({ concept_id: x.concept_id }));
    return resultWithCount(rows);
  }

  if (q.startsWith("select concept_id from activities where session_id =") && q.includes("and sequence_no =")) {
    const a = s.activities.find((x) => x.session_id === String(params[0]) && x.sequence_no === Number(params[1]));
    return resultWithCount(a ? [{ concept_id: a.concept_id }] : []);
  }

  if (q.startsWith("select coalesce(spec_json->>'promptmarkdown', spec_json->>'title', '') as p from activities")) {
    const rows = s.activities
      .filter((a) => a.concept_id === String(params[0]))
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, 6)
      .map((a) => ({ p: String(a.spec_json?.promptMarkdown ?? a.spec_json?.title ?? "") }));
    return resultWithCount(rows);
  }

  if (q.startsWith("select a.spec_json, at.submission_json, at.feedback_json from activities a join attempts at")) {
    const sessionId = String(params[0]);
    const conceptId = String(params[1]);
    const matches = s.activities
      .filter((a) => a.session_id === sessionId && a.concept_id === conceptId && (a.kind === "multiple_choice" || a.kind === "free_response"))
      .sort((a, b) => b.sequence_no - a.sequence_no);
    for (const a of matches) {
      const at = s.attempts.find((x) => x.activity_id === a.id);
      if (at) {
        return resultWithCount([
          {
            spec_json: structuredClone(a.spec_json),
            submission_json: structuredClone(at.submission_json),
            feedback_json: structuredClone(at.feedback_json),
          },
        ]);
      }
    }
    return resultWithCount([]);
  }

  if (q.includes("bool_or(kind = 'explanation') as explained") && q.includes("from activities where course_id =")) {
    const courseId = String(params[0]);
    const byConcept = new Map<string, ActivityRecord[]>();
    for (const a of s.activities.filter((x) => x.course_id === courseId)) {
      const list = byConcept.get(a.concept_id) ?? [];
      list.push(a);
      byConcept.set(a.concept_id, list);
    }
    const rows = [...byConcept.entries()].map(([conceptId, list]) => ({
      concept_id: conceptId,
      explained: list.some((a) => a.kind === "explanation"),
      predicted: list.some((a) => a.purpose === "prediction" || a.purpose === "placement"),
      review_activities: list.filter((a) => a.purpose === "review").length,
    }));
    return resultWithCount(rows);
  }

  if (q.startsWith("select distinct concept_id from activities where course_id =")) {
    const ids = [...new Set(s.activities.filter((a) => a.course_id === String(params[0])).map((a) => a.concept_id))];
    return resultWithCount(ids.map((id) => ({ concept_id: id })));
  }

  if (q.startsWith("update activities set status =")) {
    const statusMatch = q.match(/status = '([^']+)'/);
    const a = s.activities.find((x) => x.id === String(params[0]));
    if (a && statusMatch) a.status = statusMatch[1] as ActivityRecord["status"];
    return resultWithCount([], a ? 1 : 0);
  }

  if (q.startsWith("update activities set hints_json =")) {
    const a = s.activities.find((x) => x.id === String(params[1]));
    if (a) a.hints_json = (unwrap(params[0]) as unknown[]) ?? [];
    return resultWithCount([], a ? 1 : 0);
  }

  if (q.startsWith("update activities set alt_explanations_json =")) {
    const a = s.activities.find((x) => x.id === String(params[1]));
    if (a) a.alt_explanations_json = (unwrap(params[0]) as unknown[]) ?? [];
    return resultWithCount([], a ? 1 : 0);
  }

  // ---------------- activity_drafts & attempts ----------------
  if (q.startsWith("select draft_json, version from activity_drafts where activity_id =")) {
    const d = s.activity_drafts.find((x) => x.activity_id === String(params[0]) && x.owner_id === String(params[1]));
    return resultWithCount(d ? [{ draft_json: structuredClone(d.draft_json), version: d.version }] : []);
  }

  if (q.startsWith("select version, draft_json from activity_drafts where activity_id =")) {
    const d = s.activity_drafts.find((x) => x.activity_id === String(params[0]));
    return resultWithCount(d ? [{ version: d.version, draft_json: structuredClone(d.draft_json) }] : []);
  }

  if (q.startsWith("insert into activity_drafts")) {
    const activityId = String(params[0]);
    const ownerId = String(params[1]);
    const draftJson = (unwrap(params[2]) as Record<string, unknown>) ?? {};
    const existing = s.activity_drafts.find((x) => x.activity_id === activityId);
    if (existing) {
      existing.draft_json = draftJson;
      existing.version += 1;
      existing.updated_at = now;
      return resultWithCount([{ version: existing.version }]);
    }
    s.activity_drafts.push({ activity_id: activityId, owner_id: ownerId, draft_json: draftJson, version: 1, updated_at: now });
    return resultWithCount([{ version: 1 }]);
  }

  if (q.startsWith("delete from activity_drafts where activity_id =")) {
    const before = s.activity_drafts.length;
    s.activity_drafts = s.activity_drafts.filter((x) => x.activity_id !== String(params[0]));
    return resultWithCount([], before - s.activity_drafts.length);
  }

  if (q.startsWith("select * from attempts where activity_id =")) {
    const at = s.attempts.find((x) => x.activity_id === String(params[0]));
    return resultWithCount(at ? [structuredClone(at)] : []);
  }

  if (q.startsWith("select * from attempts where owner_id =") && q.includes("and idempotency_key =")) {
    const at = s.attempts.find((x) => x.owner_id === String(params[0]) && x.idempotency_key === String(params[1]));
    return resultWithCount(at ? [structuredClone(at)] : []);
  }

  if (q.startsWith("select * from attempts where id =")) {
    const at = s.attempts.find((x) => x.id === String(params[0]));
    return resultWithCount(at ? [structuredClone(at)] : []);
  }

  if (q.startsWith("select * from attempts where owner_id =")) {
    return resultWithCount(s.attempts.filter((x) => x.owner_id === String(params[0])).map((x) => structuredClone(x)));
  }

  if (q.startsWith("insert into attempts")) {
    const at: AttemptRecord = {
      id: randomUUID(),
      activity_id: String(params[0]),
      owner_id: String(params[1]),
      submission_json: (unwrap(params[2]) as Record<string, unknown>) ?? {},
      hint_count: Number(params[3]),
      explanation_revealed: Boolean(params[4]),
      idempotency_key: String(params[5]),
      status: params[6] as AttemptRecord["status"],
      feedback_json: null,
      submitted_at: now,
    };
    s.attempts.push(at);
    return resultWithCount([structuredClone(at)]);
  }

  if (q.startsWith("update attempts set status = 'graded', feedback_json =")) {
    const at = s.attempts.find((x) => x.id === String(params[1]));
    if (at) {
      at.status = "graded";
      at.feedback_json = (unwrap(params[0]) as Record<string, unknown>) ?? null;
    }
    return resultWithCount([], at ? 1 : 0);
  }

  if (q.startsWith("update attempts set feedback_json =") && q.includes("explanation_revealed = true")) {
    const at = s.attempts.find((x) => x.id === String(params[1]));
    if (at) {
      at.feedback_json = (unwrap(params[0]) as Record<string, unknown>) ?? null;
      at.explanation_revealed = true;
    }
    return resultWithCount([], at ? 1 : 0);
  }

  if (q.startsWith("update attempts set feedback_json =")) {
    const at = s.attempts.find((x) => x.id === String(params[1]));
    if (at) {
      at.feedback_json = (unwrap(params[0]) as Record<string, unknown>) ?? null;
    }
    return resultWithCount([], at ? 1 : 0);
  }

  if (q.startsWith("select at.feedback_json->>'misconception' as m from attempts at")) {
    const conceptId = String(params[0]);
    const rows = s.attempts
      .filter((at) => {
        const a = s.activities.find((x) => x.id === at.activity_id);
        return a?.concept_id === conceptId && typeof at.feedback_json?.misconception === "string" && at.feedback_json.misconception.length > 0;
      })
      .sort((a, b) => b.submitted_at.getTime() - a.submitted_at.getTime())
      .slice(0, 3)
      .map((at) => ({ m: String(at.feedback_json!.misconception) }));
    return resultWithCount(rows);
  }

  if (q.startsWith("select at.submission_json->>'text' as text from attempts at")) {
    if (q.includes("a.session_id =")) {
      const sessionId = String(params[0]);
      const rows = s.attempts
        .map((at) => ({ at, a: s.activities.find((x) => x.id === at.activity_id) }))
        .filter(({ at, a }) => a?.session_id === sessionId && a.kind === "reflection" && typeof at.submission_json?.text === "string")
        .sort((x, y) => (x.a?.sequence_no ?? 0) - (y.a?.sequence_no ?? 0))
        .map(({ at }) => ({ text: String(at.submission_json.text) }));
      return resultWithCount(rows);
    }
    const courseId = String(params[0]);
    const rows = s.attempts
      .filter((at) => {
        const a = s.activities.find((x) => x.id === at.activity_id);
        return a?.course_id === courseId && a.kind === "reflection" && typeof at.submission_json?.text === "string";
      })
      .sort((a, b) => b.submitted_at.getTime() - a.submitted_at.getTime())
      .slice(0, 5)
      .map((at) => ({ text: String(at.submission_json.text) }));
    return resultWithCount(rows);
  }

  // ---------------- assessment_evidence, mastery_estimates, review_items, prepared_activities ----------------
  if (q.startsWith("insert into assessment_evidence")) {
    s.assessment_evidence.push({
      id: randomUUID(),
      attempt_id: String(params[0]),
      course_id: String(params[1]),
      concept_id: String(params[2]),
      activity_kind: String(params[3]),
      purpose: String(params[4]),
      result: String(params[5]),
      score: (params[6] as number | null) ?? null,
      independence: String(params[7]),
      difficulty: (params[8] as number | null) ?? null,
      rubric_json: unwrap(params[9]),
      reason: String(params[10] ?? ""),
      evaluator_json: (unwrap(params[11]) as Record<string, unknown>) ?? {},
      recall: (params[12] as "prompted" | "unprompted") ?? "unprompted",
      created_at: now,
    });
    return resultWithCount([], 1);
  }

  if (q.startsWith("select concept_id, result, independence, activity_kind, created_at, reason from assessment_evidence")) {
    const rows = s.assessment_evidence
      .filter((e) => e.course_id === String(params[0]))
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .map((e) => ({
        concept_id: e.concept_id,
        result: e.result,
        independence: e.independence,
        activity_kind: e.activity_kind,
        created_at: e.created_at,
        reason: e.reason,
      }));
    return resultWithCount(rows);
  }

  if (q.startsWith("select at.activity_id, e.result, e.independence, e.difficulty, e.purpose, e.recall, e.created_at from assessment_evidence e")) {
    const rows = s.assessment_evidence
      .filter((e) => e.concept_id === String(params[0]))
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .flatMap((e) => {
        const at = s.attempts.find((x) => x.id === e.attempt_id);
        return at
          ? [
              {
                activity_id: at.activity_id,
                result: e.result,
                independence: e.independence,
                difficulty: e.difficulty,
                purpose: e.purpose,
                recall: e.recall,
                created_at: e.created_at,
              },
            ]
          : [];
      });
    return resultWithCount(rows);
  }

  if (q.startsWith("select result, reason from assessment_evidence where concept_id =")) {
    const rows = s.assessment_evidence
      .filter((e) => e.concept_id === String(params[0]) && e.result !== "exposure")
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, 5)
      .map((e) => ({ result: e.result, reason: e.reason }));
    return resultWithCount(rows);
  }

  if (q.startsWith("select count(*)::int as misses from assessment_evidence where concept_id =")) {
    const conceptId = String(params[0]);
    const misses = s.assessment_evidence.filter((e) => e.concept_id === conceptId && (e.result === "incorrect" || e.result === "partial")).length;
    return resultWithCount([{ misses }]);
  }

  if (q.includes("from assessment_evidence where course_id =") && q.includes("group by concept_id")) {
    const courseId = String(params[0]);
    const byConcept = new Map<string, EvidenceRecord[]>();
    for (const e of s.assessment_evidence.filter((x) => x.course_id === courseId && x.result !== "exposure")) {
      const list = byConcept.get(e.concept_id) ?? [];
      list.push(e);
      byConcept.set(e.concept_id, list);
    }
    const rows = [...byConcept.entries()].map(([conceptId, list]) => {
      const taught = list.filter((e) => e.purpose !== "prediction" && e.purpose !== "placement").sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      return {
        concept_id: conceptId,
        n: list.length,
        taught: taught.length,
        placed_out: list.some((e) => e.purpose === "placement" && e.result === "correct" && (e.difficulty ?? 1) >= 2),
        last_kind: taught[0]?.activity_kind ?? null,
      };
    });
    return resultWithCount(rows);
  }

  if (q.startsWith("select c.title, e.created_at from assessment_evidence e join concepts c")) {
    const rows = s.assessment_evidence
      .filter((e) => e.course_id === String(params[0]) && e.activity_kind === "free_response" && e.result === "correct")
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, 5)
      .map((e) => ({ title: s.concepts.find((c) => c.id === e.concept_id)?.title ?? "", created_at: e.created_at }));
    return resultWithCount(rows);
  }

  if (q.startsWith("insert into mastery_estimates")) {
    const courseId = String(params[0]);
    const conceptId = String(params[1]);
    if (q.includes("'not_assessed'")) {
      s.mastery_estimates.push({
        course_id: courseId,
        concept_id: conceptId,
        status: "not_assessed",
        confidence: "none",
        last_independent_success_at: null,
        last_assessed_at: null,
        details_json: {},
        updated_at: now,
      });
      return resultWithCount([], 1);
    }
    const existing = s.mastery_estimates.find((m) => m.course_id === courseId && m.concept_id === conceptId);
    const next: MasteryRecord = {
      course_id: courseId,
      concept_id: conceptId,
      status: String(params[2]),
      confidence: String(params[3]),
      last_independent_success_at: params[4] ? asDate(params[4]) : null,
      last_assessed_at: params[5] ? asDate(params[5]) : null,
      details_json: (unwrap(params[6]) as Record<string, unknown>) ?? {},
      updated_at: now,
    };
    if (existing) Object.assign(existing, next);
    else s.mastery_estimates.push(next);
    return resultWithCount([], 1);
  }

  if (q.startsWith("select status from mastery_estimates where concept_id =")) {
    const m = s.mastery_estimates.find((x) => x.concept_id === String(params[0]));
    return resultWithCount(m ? [{ status: m.status }] : []);
  }

  if (q.startsWith("select count(*)::int as due from review_items where course_id =")) {
    const due = s.review_items.filter((r) => r.course_id === String(params[0]) && r.status === "active" && r.due_at <= now).length;
    return resultWithCount([{ due }]);
  }

  if (q.startsWith("select c.title, r.due_at from review_items r join concepts c")) {
    const rows = s.review_items
      .filter((r) => r.course_id === String(params[0]) && r.status === "active")
      .sort((a, b) => a.due_at.getTime() - b.due_at.getTime())
      .slice(0, 10)
      .map((r) => ({ title: s.concepts.find((c) => c.id === r.concept_id)?.title ?? "", due_at: r.due_at }));
    return resultWithCount(rows);
  }

  if (q.startsWith("select * from review_items where id =")) {
    const r = s.review_items.find((x) => x.id === String(params[0]));
    return resultWithCount(r ? [structuredClone(r)] : []);
  }

  if (q.startsWith("select id, due_at from review_items where id =")) {
    const r = s.review_items.find((x) => x.id === String(params[0]) && x.owner_id === String(params[1]) && x.status === "active");
    return resultWithCount(r ? [{ id: r.id, due_at: r.due_at }] : []);
  }

  if (q.startsWith("select id from review_items where concept_id =")) {
    const r = s.review_items.find((x) => x.concept_id === String(params[0]) && x.status === "active");
    return resultWithCount(r ? [{ id: r.id }] : []);
  }

  if (q.startsWith("select * from review_items where owner_id =")) {
    return resultWithCount(s.review_items.filter((x) => x.owner_id === String(params[0])).map((x) => structuredClone(x)));
  }

  if (q.startsWith("select r.id, r.course_id, co.title as course_title, r.concept_id, c.title as concept_title, r.due_at from review_items r")) {
    const ownerId = String(params[0]);
    const horizonMs = parseIntervalMs(String(params[1] ?? "0 days"));
    const maxDue = new Date(now.getTime() + horizonMs);
    const rows = s.review_items
      .filter((r) => r.owner_id === ownerId && r.status === "active" && r.due_at <= maxDue)
      .flatMap((r) => {
        const co = s.courses.find((x) => x.id === r.course_id);
        const c = s.concepts.find((x) => x.id === r.concept_id);
        if (!co || co.status === "archived" || !c) return [];
        return [{ id: r.id, course_id: r.course_id, course_title: co.title, concept_id: r.concept_id, concept_title: c.title, due_at: r.due_at }];
      })
      .sort((a, b) => a.due_at.getTime() - b.due_at.getTime())
      .slice(0, 100);
    return resultWithCount(rows);
  }

  if (q.startsWith("select c.title as concept, co.title as course from review_items r")) {
    const ownerId = String(params[0]);
    const refNow = asDate(params[1]);
    const rows = s.review_items
      .filter((r) => r.owner_id === ownerId && r.status === "active" && r.due_at <= refNow)
      .flatMap((r) => {
        const co = s.courses.find((x) => x.id === r.course_id);
        const c = s.concepts.find((x) => x.id === r.concept_id);
        if (!co || co.status === "archived" || !c) return [];
        return [{ due_at: r.due_at, concept: c.title, course: co.title }];
      })
      .sort((a, b) => a.due_at.getTime() - b.due_at.getTime())
      .slice(0, 50)
      .map(({ concept, course }) => ({ concept, course }));
    return resultWithCount(rows);
  }

  if (q.startsWith("insert into review_items")) {
    const conceptId = String(params[1]);
    if (s.review_items.some((r) => r.concept_id === conceptId && r.status === "active")) return resultWithCount([]);
    s.review_items.push({
      id: randomUUID(),
      course_id: String(params[0]),
      concept_id: conceptId,
      owner_id: String(params[2]),
      due_at: asDate(params[3]),
      interval_days: Number(params[4]),
      repetitions: Number(params[5]),
      status: "active",
      last_review_at: null,
      created_at: now,
    });
    return resultWithCount([], 1);
  }

  if (q.startsWith("update review_items set interval_days =")) {
    const r = s.review_items.find((x) => x.id === String(params[4]));
    if (r) {
      r.interval_days = Number(params[0]);
      r.repetitions = Number(params[1]);
      r.due_at = asDate(params[2]);
      r.last_review_at = asDate(params[3]);
    }
    return resultWithCount([], r ? 1 : 0);
  }

  if (q.startsWith("update review_items set due_at =")) {
    const r = s.review_items.find((x) => x.id === String(params[1]));
    if (r) r.due_at = asDate(params[0]);
    return resultWithCount([], r ? 1 : 0);
  }

  if (q.startsWith("select status, mode, spec_json, model_info_json, created_at from prepared_activities")) {
    const p = s.prepared_activities.find(
      (x) => x.session_id === String(params[0]) && x.after_activity_id === String(params[1]) && x.signature === String(params[2]),
    );
    return resultWithCount(
      p
        ? [
            {
              status: p.status,
              mode: p.mode,
              spec_json: structuredClone(p.spec_json),
              model_info_json: structuredClone(p.model_info_json),
              created_at: p.created_at,
            },
          ]
        : [],
    );
  }

  if (q.startsWith("insert into prepared_activities")) {
    const sessionId = String(params[0]);
    const afterId = String(params[1]);
    const sig = String(params[2]);
    if (s.prepared_activities.some((x) => x.session_id === sessionId && x.after_activity_id === afterId && x.signature === sig)) {
      return resultWithCount([]);
    }
    const p: PreparedActivityRecord = {
      id: randomUUID(),
      session_id: sessionId,
      after_activity_id: afterId,
      signature: sig,
      mode: String(params[3]),
      status: "generating",
      spec_json: null,
      model_info_json: null,
      error_code: null,
      created_at: now,
      updated_at: now,
    };
    s.prepared_activities.push(p);
    return resultWithCount([{ id: p.id }]);
  }

  if (q.startsWith("update prepared_activities set status = 'ready'")) {
    const p = s.prepared_activities.find((x) => x.id === String(params[2]));
    if (p) {
      p.status = "ready";
      p.spec_json = unwrap(params[0]);
      p.model_info_json = unwrap(params[1]);
      p.updated_at = now;
    }
    return resultWithCount([], p ? 1 : 0);
  }

  if (q.startsWith("update prepared_activities set status = 'failed'")) {
    const p = s.prepared_activities.find((x) => x.id === String(params[1]));
    if (p) {
      p.status = "failed";
      p.error_code = String(params[0]);
      p.updated_at = now;
    }
    return resultWithCount([], p ? 1 : 0);
  }

  if (q.startsWith("delete from prepared_activities where session_id =")) {
    const before = s.prepared_activities.length;
    s.prepared_activities = s.prepared_activities.filter((x) => !(x.session_id === String(params[0]) && x.after_activity_id === String(params[1])));
    return resultWithCount([], before - s.prepared_activities.length);
  }

  if (q.startsWith("delete from prepared_activities where created_at <")) {
    const cutoff = now.getTime() - 86_400_000;
    const before = s.prepared_activities.length;
    s.prepared_activities = s.prepared_activities.filter((x) => x.created_at.getTime() >= cutoff);
    return resultWithCount([], before - s.prepared_activities.length);
  }

  // ---------------- dynamic table operations (guest merge & account export) ----------------
  const mergeMatch = q.match(/^update (\w+) set owner_id = \$0 where owner_id = \$1$/);
  if (mergeMatch) {
    const table = mergeMatch[1] as keyof MemoryStore;
    const targetOwner = String(params[0]);
    const guestId = String(params[1]);
    const rows = s[table];
    let count = 0;
    if (Array.isArray(rows)) {
      for (const row of rows as unknown as Record<string, unknown>[]) {
        if (row.owner_id === guestId) {
          row.owner_id = targetOwner;
          count++;
        }
      }
    }
    return resultWithCount([], count);
  }

  const exportMatch = q.match(/^select \* from (\w+) where course_id in \$0$/);
  if (exportMatch) {
    const table = exportMatch[1] as keyof MemoryStore;
    const ids = new Set((unwrap(params[0]) as string[]) ?? []);
    const rows = s[table];
    if (Array.isArray(rows)) {
      const matched = (rows as unknown as Record<string, unknown>[]).filter((r) => ids.has(String(r.course_id)));
      return resultWithCount(structuredClone(matched));
    }
    return resultWithCount([]);
  }

  return resultWithCount([]);
}

export function createMemoryDb(): postgres.Sql<Record<string, never>> {
  if (!globalForMem.__adaMemoryWarned) {
    globalForMem.__adaMemoryWarned = true;
    console.warn("[AI Studio] DATABASE_URL not configured — using in-memory mock database (ephemeral).");
  }

  const sqlFn = ((first: TemplateStringsArray | string | unknown[], ...rest: unknown[]) => {
    if (!Array.isArray(first) || !("raw" in first)) {
      if (typeof first === "string") return { __adaIdent: first } satisfies IdentWrapper;
      if (Array.isArray(first)) return { __adaList: first } satisfies ListWrapper;
      return { __adaJson: first } satisfies JsonWrapper;
    }
    const strings = first as TemplateStringsArray;
    const params: unknown[] = [];
    let built = strings[0] ?? "";
    for (let i = 0; i < rest.length; i++) {
      const val = rest[i];
      if (isIdentWrapper(val)) {
        built += val.__adaIdent + (strings[i + 1] ?? "");
      } else {
        const idx = params.length;
        params.push(val);
        built += `$${idx}` + (strings[i + 1] ?? "");
      }
    }
    return Promise.resolve(executeQuery(built, params));
  }) as unknown as postgres.Sql<Record<string, never>>;

  Object.assign(sqlFn, {
    begin: async <T>(fn: (t: postgres.TransactionSql<Record<string, never>>) => Promise<T>): Promise<T> => {
      return fn(sqlFn as unknown as postgres.TransactionSql<Record<string, never>>);
    },
    json: (value: unknown): JsonWrapper => ({ __adaJson: value }),
    end: async () => {},
  });

  return sqlFn;
}

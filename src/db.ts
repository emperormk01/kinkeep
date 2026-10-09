import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CircleMember {
  id: number;
  name: string;
  role: string;
  phone: string | null;
}

export interface Appointment {
  id: number;
  title: string;
  starts_at: string;
  duration_min: number;
  with_whom: string | null;
  notes: string | null;
  completed: number;
}

export interface Medication {
  id: number;
  name: string;
  dose: string;
  times: string;
  with_food: number;
  notes: string | null;
}

export interface MedLog {
  id: number;
  medication_id: number;
  taken_at: string;
}

export interface Reminder {
  id: number;
  text: string;
  due_at: string;
  completed: number;
}

export interface JournalEntry {
  id: number;
  kind: string;
  text: string;
  at: string;
  by: string | null;
}

export interface OAuthCode {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  resource: string | null;
  expires_at: number;
  used: number;
}

export interface OAuthToken {
  token_hash: string;
  kind: "access" | "refresh";
  client_id: string;
  scope: string;
  resource: string | null;
  expires_at: number;
  created_at: number;
  revoked: number;
}

export class KinKeepDb {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  migrate() {
    const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");
    this.db.exec(schema);
  }

  seedIfEmpty() {
    const count = this.db
      .prepare("SELECT COUNT(*) AS n FROM circle")
      .get() as { n: number };
    if (count.n > 0) return false;

    const tomorrow = (offset: number, h: number, m = 0) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      d.setHours(h, m, 0, 0);
      return d.toISOString();
    };

    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO circle (name, role, phone) VALUES (?, ?, ?)"
        )
        .run("Margaret", "self", null);
      this.db
        .prepare("INSERT INTO circle (name, role, phone) VALUES (?, ?, ?)")
        .run("Dana", "daughter", "555-0142");
      this.db
        .prepare("INSERT INTO circle (name, role, phone) VALUES (?, ?, ?)")
        .run("Robert", "son", "555-0177");
      this.db
        .prepare("INSERT INTO circle (name, role, phone) VALUES (?, ?, ?)")
        .run("Dr. Alvarez", "gp", "555-0190");
      this.db
        .prepare("INSERT INTO circle (name, role, phone) VALUES (?, ?, ?)")
        .run("Aisha", "carer", "555-0133");

      this.db
        .prepare(
          "INSERT INTO appointments (title, starts_at, duration_min, with_whom, notes) VALUES (?, ?, ?, ?, ?)"
        )
        .run("Dr. Alvarez — blood pressure review", tomorrow(0, 10, 30), 30, "Dr. Alvarez", "Bring the home readings log");
      this.db
        .prepare(
          "INSERT INTO appointments (title, starts_at, duration_min, with_whom, notes) VALUES (?, ?, ?, ?, ?)"
        )
        .run("Hair appointment", tomorrow(1, 14, 0), 60, "Salon Bella", null);
      this.db
        .prepare(
          "INSERT INTO appointments (title, starts_at, duration_min, with_whom, notes) VALUES (?, ?, ?, ?, ?)"
        )
        .run("Library book club", tomorrow(3, 11, 0), 90, null, "Reading 'The Salt Path'");

      this.db
        .prepare(
          "INSERT INTO medications (name, dose, times, with_food, notes) VALUES (?, ?, ?, ?, ?)"
        )
        .run("Lisinopril", "10 mg", "08:00", 0, "Blood pressure");
      this.db
        .prepare(
          "INSERT INTO medications (name, dose, times, with_food, notes) VALUES (?, ?, ?, ?, ?)"
        )
        .run("Metformin", "500 mg", "08:00,19:00", 1, "Take with food");
      this.db
        .prepare(
          "INSERT INTO medications (name, dose, times, with_food, notes) VALUES (?, ?, ?, ?, ?)"
        )
        .run("Vitamin D", "1000 IU", "12:00", 1, null);

      this.db
        .prepare("INSERT INTO reminders (text, due_at) VALUES (?, ?)")
        .run("Call Dana back about the heating engineer", tomorrow(0, 16, 0));
      this.db
        .prepare("INSERT INTO reminders (text, due_at) VALUES (?, ?)")
        .run("Water the front window boxes", tomorrow(1, 9, 0));
      this.db
        .prepare("INSERT INTO reminders (text, due_at) VALUES (?, ?)")
        .run("Bin collection is Thursday — put out the blue bin", tomorrow(2, 19, 0));

      this.db
        .prepare(
          "INSERT INTO journal (kind, text, at, by) VALUES (?, ?, ?, ?)"
        )
        .run("visit", "Aisha came for tea and helped with the weekly shop.", tomorrow(-1, 15, 0), "Aisha");
      this.db
        .prepare("INSERT INTO journal (kind, text, at, by) VALUES (?, ?, ?, ?)")
        .run("call", "Robert called — he'll visit on Sunday.", tomorrow(-2, 18, 30), "Robert");
      this.db
        .prepare("INSERT INTO journal (kind, text, at, by) VALUES (?, ?, ?, ?)")
        .run("note", "Blood pressure 138/82 this morning.", tomorrow(0, 8, 15), "Margaret");
    })();
    return true;
  }

  listCircle(): CircleMember[] {
    return this.db.prepare("SELECT * FROM circle ORDER BY id").all() as CircleMember[];
  }

  appointmentsOn(dayIso: string): Appointment[] {
    return this.db
      .prepare(
        "SELECT * FROM appointments WHERE substr(starts_at, 1, 10) = ? ORDER BY starts_at"
      )
      .all(dayIso) as Appointment[];
  }

  upcomingAppointments(limit = 10): Appointment[] {
    return this.db
      .prepare(
        "SELECT * FROM appointments WHERE starts_at > datetime('now') ORDER BY starts_at LIMIT ?"
      )
      .all(limit) as Appointment[];
  }

  addAppointment(
    title: string,
    startsAt: string,
    durationMin: number,
    withWhom: string | null,
    notes: string | null
  ): Appointment {
    const info = this.db
      .prepare(
        "INSERT INTO appointments (title, starts_at, duration_min, with_whom, notes) VALUES (?, ?, ?, ?, ?)"
      )
      .run(title, startsAt, durationMin, withWhom, notes);
    return this.db
      .prepare("SELECT * FROM appointments WHERE id = ?")
      .get(info.lastInsertRowid) as Appointment;
  }

  completeAppointment(id: number): boolean {
    return this.db
      .prepare("UPDATE appointments SET completed = 1 WHERE id = ?")
      .run(id).changes > 0;
  }

  medications(): Medication[] {
    return this.db.prepare("SELECT * FROM medications ORDER BY name").all() as Medication[];
  }

  medLogsOn(dayIso: string): MedLog[] {
    return this.db
      .prepare(
        `SELECT ml.* FROM med_log ml
         JOIN medications m ON m.id = ml.medication_id
         WHERE substr(ml.taken_at, 1, 10) = ?
         ORDER BY ml.taken_at`
      )
      .all(dayIso) as MedLog[];
  }

  logMedication(medicationId: number, takenAt: string): MedLog {
    const info = this.db
      .prepare("INSERT INTO med_log (medication_id, taken_at) VALUES (?, ?)")
      .run(medicationId, takenAt);
    return this.db
      .prepare("SELECT * FROM med_log WHERE id = ?")
      .get(info.lastInsertRowid) as MedLog;
  }

  remindersOpen(): Reminder[] {
    return this.db
      .prepare(
        "SELECT * FROM reminders WHERE completed = 0 ORDER BY due_at"
      )
      .all() as Reminder[];
  }

  addReminder(text: string, dueAt: string): Reminder {
    const info = this.db
      .prepare("INSERT INTO reminders (text, due_at) VALUES (?, ?)")
      .run(text, dueAt);
    return this.db
      .prepare("SELECT * FROM reminders WHERE id = ?")
      .get(info.lastInsertRowid) as Reminder;
  }

  completeReminder(id: number): boolean {
    return this.db
      .prepare("UPDATE reminders SET completed = 1 WHERE id = ?")
      .run(id).changes > 0;
  }

  journalRecent(limit = 10): JournalEntry[] {
    return this.db
      .prepare("SELECT * FROM journal ORDER BY at DESC LIMIT ?")
      .all(limit) as JournalEntry[];
  }

  addJournal(kind: string, text: string, at: string, by: string | null): JournalEntry {
    const info = this.db
      .prepare("INSERT INTO journal (kind, text, at, by) VALUES (?, ?, ?, ?)")
      .run(kind, text, at, by);
    return this.db
      .prepare("SELECT * FROM journal WHERE id = ?")
      .get(info.lastInsertRowid) as JournalEntry;
  }

  storeAuthCode(code: OAuthCode): void {
    this.db
      .prepare(
        `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, code_challenge_method, scope, resource, expires_at, used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(code.code_hash, code.client_id, code.redirect_uri, code.code_challenge, code.code_challenge_method, code.scope, code.resource, code.expires_at);
  }

  // Single use: the UPDATE is itself the claim, so two racing exchanges cannot both win.
  claimAuthCode(codeHash: string, now: number): OAuthCode | null {
    const row = this.db
      .prepare("UPDATE oauth_codes SET used = 1 WHERE code_hash = ? AND used = 0 AND expires_at >= ? RETURNING *")
      .get(codeHash, now) as OAuthCode | undefined;
    return row ?? null;
  }

  storeOAuthToken(token: OAuthToken): void {
    this.db
      .prepare(
        `INSERT INTO oauth_tokens (token_hash, kind, client_id, scope, resource, expires_at, created_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(token.token_hash, token.kind, token.client_id, token.scope, token.resource, token.expires_at, token.created_at);
  }

  findOAuthToken(tokenHash: string): OAuthToken | null {
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ?").get(tokenHash) as OAuthToken | undefined;
    return row ?? null;
  }

  revokeOAuthToken(tokenHash: string): boolean {
    return this.db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ? AND revoked = 0").run(tokenHash).changes > 0;
  }

  pruneOAuth(now: number): void {
    this.db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").run(now);
  }

  close() {
    this.db.close();
  }
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function dayIso(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

export function parseFlexibleDate(input: string): string | null {
  const now = new Date();
  const t = input.trim().toLowerCase();
  if (t === "today") return dayIso(0);
  if (t === "tomorrow") return dayIso(1);
  const weekdayMatch = t.match(/^next\s+(\w+)$/);
  if (weekdayMatch) {
    const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const target = names.indexOf(weekdayMatch[1]);
    if (target === -1) return null;
    const d = new Date(now);
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    d.setDate(d.getDate() + delta);
    return d.toISOString().slice(0, 10);
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
  if (iso) return iso;
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function toIsoTimestamp(datePart: string, timePart: string): string | null {
  const day = parseFlexibleDate(datePart);
  if (!day) return null;
  const tm = /^\d{1,2}:\d{2}$/.test(timePart) ? timePart : null;
  if (!tm) return null;
  const [h, m] = tm.split(":").map(Number);
  if (h > 23 || m > 59) return null;
  const d = new Date(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function speakableTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const ap = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${ap}` : `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}

export function speakableDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const dayDiff = Math.round(
    (startOf(d).getTime() - startOf(today).getTime()) / 86_400_000
  );
  if (dayDiff === 0) return "today";
  if (dayDiff === 1) return "tomorrow";
  if (dayDiff === -1) return "yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

// "today"/"tomorrow"/"yesterday" already carry the sense of a day, so they take
// no preposition; named dates take "on ".
export function dayPreposition(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const dayDiff = Math.round(
    (startOf(d).getTime() - startOf(today).getTime()) / 86_400_000
  );
  return [-1, 0, 1].includes(dayDiff) ? "" : "on ";
}

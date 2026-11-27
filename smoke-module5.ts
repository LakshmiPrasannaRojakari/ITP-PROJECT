/**
 * Module 5 production smoke test — run against the real `next start` build on
 * the development database, then fully cleaned up (rows, stored files, server).
 *
 * Usage: npx tsx smoke-module5.ts
 */
import "dotenv/config";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./src/generated/prisma/client";

const ROOT = process.cwd();
const BASE = "http://127.0.0.1:3000";
const STORAGE_DIR = process.env.DOCUMENT_STORAGE_DIR || join(ROOT, "storage", "documents");
const LOG_FILE = join(process.env.TEMP || ".", "module5-smoke-server.log");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }),
});

/* -------------------------------------------------------------------------- */
/*  Reporting                                                                  */
/* -------------------------------------------------------------------------- */

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): boolean {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(detail ? `${name} — ${detail}` : name);
    console.log(`FAIL   ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return cond;
}

function must(name: string, cond: boolean, detail = ""): void {
  if (!check(name, cond, detail)) throw new Error(`setup step failed: ${name}`);
}

/* -------------------------------------------------------------------------- */
/*  HTTP client with a real cookie jar                                         */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;
type CallResult = { status: number; body: Json; text: string; response: Response };

class Actor {
  cookie: string | null = null;
  constructor(readonly label: string) {}

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", `scvp_session=${this.cookie}`);
    if (!headers.has("origin")) headers.set("origin", BASE);
    if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", "203.0.113.42");
    if (
      init.body !== undefined &&
      !(init.body instanceof FormData) &&
      !headers.has("content-type")
    ) {
      headers.set("content-type", "application/json");
    }
    const response = await fetch(`${BASE}${path}`, {
      ...init,
      redirect: init.redirect ?? "manual",
    });
    for (const entry of response.headers.getSetCookie()) {
      const [pair] = entry.split(";");
      if (pair && pair.startsWith("scvp_session=")) {
        const value = pair.slice("scvp_session=".length);
        this.cookie = value === "" ? null : value;
      }
    }
    return response;
  }

  async json(path: string, init: RequestInit = {}): Promise<CallResult> {
    const response = await this.fetch(path, init);
    const text = await response.text();
    let body: Json = {};
    if (text) {
      try {
        body = JSON.parse(text) as Json;
      } catch {
        body = { raw: text };
      }
    }
    return { status: response.status, body, text, response };
  }

  get(path: string): Promise<CallResult> {
    return this.json(path, { method: "GET" });
  }

  post(path: string, body: unknown): Promise<CallResult> {
    return this.json(path, { method: "POST", body: JSON.stringify(body) });
  }

  postForm(path: string, form: FormData): Promise<CallResult> {
    return this.json(path, { method: "POST", body: form });
  }
}

function code(result: { body: Json }): string {
  const error = result.body.error as { code?: string } | undefined;
  return error?.code ?? "<no-code>";
}

async function register(label: string): Promise<Actor & { email: string; password: string }> {
  const stamp = `${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
  const email = `smoke-${label}-${stamp}@example.test`;
  const password = "Str0ngPass!23";
  const actor = new Actor(label) as Actor & { email: string; password: string };
  actor.email = email;
  actor.password = password;
  const registered = await actor.post("/api/auth/register", {
    fullName: `Smoke ${label}`,
    email,
    phoneNumber: "9876543210",
    password,
    confirmPassword: password,
  });
  if (registered.status !== 201) {
    throw new Error(`register(${label}) failed: ${registered.status} ${registered.text}`);
  }
  return actor;
}

async function login(actor: Actor & { email: string; password: string }): Promise<void> {
  const result = await actor.post("/api/auth/login", {
    email: actor.email,
    password: actor.password,
  });
  if (result.status !== 200) throw new Error(`login(${actor.label}) failed: ${result.text}`);
}

/* -------------------------------------------------------------------------- */
/*  File bytes                                                                 */
/* -------------------------------------------------------------------------- */

const encoder = new TextEncoder();
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

function payload(text: string): Uint8Array<ArrayBuffer> {
  const body = encoder.encode(text);
  const bytes = new Uint8Array(PDF_MAGIC.length + body.length);
  bytes.set(PDF_MAGIC, 0);
  bytes.set(body, PDF_MAGIC.length);
  return bytes;
}

const SCAN_BYTES = payload("module-5 identity scan");
const SCAN_FILE = () =>
  new File([SCAN_BYTES], "identity-proof.pdf", { type: "application/pdf" });

function uploadForm(
  certificationId: string,
  documentType: string,
  file: File | null,
  extra: Record<string, string> = {},
): FormData {
  const form = new FormData();
  form.set("certificationId", certificationId);
  form.set("documentType", documentType);
  if (file) form.set("file", file);
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
}

const REASON = "The scan is cropped and the document number is unreadable.";

/* -------------------------------------------------------------------------- */
/*  Server lifecycle                                                           */
/* -------------------------------------------------------------------------- */

let server: ChildProcess | null = null;

async function startServer(): Promise<void> {
  const fd = openSync(LOG_FILE, "a");
  server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", "3000", "-H", "127.0.0.1"],
    { cwd: ROOT, env: process.env, stdio: ["ignore", fd, fd] },
  );
  server.on("error", (error) => {
    console.error(`[spawn error] ${error.message}`);
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/login`, { redirect: "manual" });
      if (response.status === 200) {
        closeSync(fd);
        return;
      }
    } catch {
      /* server not up yet */
    }
    await sleep(1000);
  }
  closeSync(fd);
  throw new Error(`server did not become ready — see ${LOG_FILE}`);
}

function stopServer(): void {
  if (server?.pid) {
    try {
      execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  server = null;
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const baseline = {
    users: await prisma.user.count(),
    skills: await prisma.skill.count(),
    certifications: await prisma.certification.count(),
    documents: await prisma.document.count(),
    audits: await prisma.auditLog.count(),
  };
  console.log(`baseline counts: ${JSON.stringify(baseline)}`);

  console.log("booting production server...");
  await startServer();
  console.log("server ready\n");

  const smokeIds = { users: [] as string[], certifications: [] as string[], skills: [] as string[] };
  const storedFiles: string[] = [];

  try {
    /* ---------------------------------------------------------------- */
    /* 1. Pages: anonymous entry                                         */
    /* ---------------------------------------------------------------- */
    console.log("— anonymous entry —");
    const guest = new Actor("guest");

    const loginPage = await guest.get("/login");
    check("anonymous /login renders (200)", loginPage.status === 200, String(loginPage.status));

    const candidateRedirect = await guest.fetch("/candidate/documents");
    const candidateLocation = candidateRedirect.headers.get("location") ?? "";
    check(
      "anonymous /candidate/documents redirects to /login",
      candidateRedirect.status >= 300 &&
        candidateRedirect.status < 400 &&
        candidateLocation.includes("/login"),
      `${candidateRedirect.status} → ${candidateLocation}`,
    );

    const guestApi = await guest.get("/api/candidate/documents");
    check(
      "anonymous document API → 401 UNAUTHENTICATED",
      guestApi.status === 401 && code(guestApi) === "UNAUTHENTICATED",
      `${guestApi.status} ${code(guestApi)}`,
    );

    const guestFile = await guest.get("/api/candidate/documents/00000000-0000-4000-8000-000000000000/file");
    check("anonymous file download → 401", guestFile.status === 401, String(guestFile.status));

    /* ---------------------------------------------------------------- */
    /* 2. Actors                                                         */
    /* ---------------------------------------------------------------- */
    console.log("\n— actors —");
    const a = await register("owner");
    await login(a);
    const aRow = await prisma.user.findUnique({ where: { email: a.email } });
    must("candidate A registered", aRow !== null);
    const aId = aRow!.id;
    smokeIds.users.push(aId);

    await prisma.eKYCVerification.upsert({
      where: { userId: aId },
      create: {
        userId: aId,
        provider: "unconfigured",
        status: "VERIFIED",
        consentGivenAt: new Date(),
        consentVersion: "v1",
        verificationStartedAt: new Date(),
        verificationCompletedAt: new Date(),
      },
      update: { status: "VERIFIED", verificationCompletedAt: new Date() },
    });

    const c = await register("stranger");
    await login(c);
    const cRow = await prisma.user.findUnique({ where: { email: c.email } });
    must("candidate C registered", cRow !== null);
    smokeIds.users.push(cRow!.id);

    const v = await register("verifier");
    await login(v);
    const vRow = await prisma.user.findUnique({ where: { email: v.email } });
    must("verifier V registered", vRow !== null);
    const vId = vRow!.id;
    smokeIds.users.push(vId);
    await prisma.user.update({ where: { id: vId }, data: { role: "VERIFIER" } });

    const m = await register("admin");
    await login(m);
    const mRow = await prisma.user.findUnique({ where: { email: m.email } });
    must("admin M registered", mRow !== null);
    smokeIds.users.push(mRow!.id);
    await prisma.user.update({ where: { id: mRow!.id }, data: { role: "ADMIN" } });

    check("four actors hold live sessions", Boolean(a.cookie && c.cookie && v.cookie && m.cookie));

    /* ---------------------------------------------------------------- */
    /* 3. Module 4 prerequisites: submitted skill + open request         */
    /* ---------------------------------------------------------------- */
    console.log("\n— certification request (Module 4 prerequisite) —");
    const skill = await a.post("/api/candidate/skills", {
      skillName: "Smoke React",
      category: "WEB_DEVELOPMENT",
      description: "Module 5 smoke fixture.",
      proficiencyLevel: "ADVANCED",
      yearsOfExperience: 3,
    });
    must("skill draft created (201)", skill.status === 201, skill.text);
    const skillId = ((skill.body.data as { skill: { id: string } }).skill).id;
    smokeIds.skills.push(skillId);

    const submitted = await a.post(`/api/candidate/skills/${skillId}/submit`, {});
    must("skill submitted (200)", submitted.status === 200, submitted.text);

    const request = await a.post("/api/candidate/certifications", { skillId });
    must("certification request raised (201 PENDING)", request.status === 201, request.text);
    const certification = (request.body.data as { certification: { id: string; status: string } })
      .certification;
    smokeIds.certifications.push(certification.id);
    must("request starts PENDING", certification.status === "PENDING", certification.status);

    /* ---------------------------------------------------------------- */
    /* 4. Upload happy path + validation                                 */
    /* ---------------------------------------------------------------- */
    console.log("\n— upload & validation —");
    const upload = await a.postForm(
      "/api/candidate/documents",
      uploadForm(certification.id, "ID_PROOF", SCAN_FILE()),
    );
    must("ID_PROOF upload → 201 PENDING", upload.status === 201, upload.text);
    const doc = (upload.body.data as { document: { id: string; status: string; originalFileName: string } }).document;
    must("uploaded row starts PENDING", doc.status === "PENDING", doc.status);

    const list = await a.get("/api/candidate/documents");
    const rows = ((list.body.data as { documents: Json[] }).documents) ?? [];
    check(
      "candidate list holds exactly the one own row and exposes submittedAt",
      list.status === 200 &&
        rows.length === 1 &&
        JSON.stringify(rows[0]).includes('"submittedAt"'),
      `${list.status} rows=${rows.length}`,
    );

    const detail = await a.get(`/api/candidate/documents/${doc.id}`);
    const detailText = detail.text;
    check(
      "detail omits storedFileName and uploadedBy",
      detail.status === 200 && !detailText.includes("storedFileName") && !detailText.includes("uploadedBy"),
      `${detail.status}`,
    );

    const mass = await a.postForm(
      "/api/candidate/documents",
      uploadForm(certification.id, "ADDRESS_PROOF", SCAN_FILE(), { status: "VERIFIED" }),
    );
    must("smuggled status field still accepted (201)", mass.status === 201, mass.text);
    const addressDoc = (mass.body.data as { document: { id: string; status: string } }).document;
    check(
      "smuggled status ignored — row is PENDING, not VERIFIED",
      addressDoc.status === "PENDING",
      addressDoc.status,
    );

    const dup = await a.postForm(
      "/api/candidate/documents",
      uploadForm(certification.id, "ID_PROOF", SCAN_FILE()),
    );
    check(
      "duplicate ID_PROOF → 409 DOCUMENT_EXISTS",
      dup.status === 409 && code(dup) === "DOCUMENT_EXISTS",
      `${dup.status} ${code(dup)}`,
    );

    const badExt = await a.postForm(
      "/api/candidate/documents",
      uploadForm(
        certification.id,
        "EDUCATION_CERTIFICATE",
        new File([encoder.encode("plain text")], "notes.txt", { type: "text/plain" }),
      ),
    );
    check(
      "disallowed extension → 400 DOCUMENT_INVALID_FILE",
      badExt.status === 400 && code(badExt) === "DOCUMENT_INVALID_FILE",
      `${badExt.status} ${code(badExt)}`,
    );

    const badMagic = await a.postForm(
      "/api/candidate/documents",
      uploadForm(
        certification.id,
        "EDUCATION_CERTIFICATE",
        new File([encoder.encode("not a real pdf at all")], "fake.pdf", { type: "application/pdf" }),
      ),
    );
    check(
      "magic-byte mismatch → 400 DOCUMENT_INVALID_FILE",
      badMagic.status === 400 && code(badMagic) === "DOCUMENT_INVALID_FILE",
      `${badMagic.status} ${code(badMagic)}`,
    );

    const huge = new Uint8Array(5 * 1024 * 1024 + 1);
    huge.set(PDF_MAGIC, 0);
    huge.fill(0x20, PDF_MAGIC.length);
    const oversize = await a.postForm(
      "/api/candidate/documents",
      uploadForm(
        certification.id,
        "EDUCATION_CERTIFICATE",
        new File([huge], "huge.pdf", { type: "application/pdf" }),
      ),
    );
    check(
      "6 MiB file → 413 DOCUMENT_TOO_LARGE",
      oversize.status === 413 && code(oversize) === "DOCUMENT_TOO_LARGE",
      `${oversize.status} ${code(oversize)}`,
    );

    const noFile = await a.postForm(
      "/api/candidate/documents",
      uploadForm(certification.id, "EDUCATION_CERTIFICATE", null),
    );
    check(
      "missing file → 400 DOCUMENT_NO_FILE",
      noFile.status === 400 && code(noFile) === "DOCUMENT_NO_FILE",
      `${noFile.status} ${code(noFile)}`,
    );

    const badId = await a.postForm(
      "/api/candidate/documents",
      uploadForm("not-a-uuid", "EDUCATION_CERTIFICATE", SCAN_FILE()),
    );
    check("malformed certificationId → 400", badId.status === 400, String(badId.status));

    const csrf = await a.postForm("/api/candidate/documents", uploadForm(certification.id, "ID_PROOF", SCAN_FILE()));
    const crossOrigin = await a.json("/api/candidate/documents", {
      method: "POST",
      body: uploadForm(certification.id, "ID_PROOF", SCAN_FILE()),
      headers: { origin: "https://evil.example" },
    });
    check(
      "cross-origin upload → 403 CSRF_REJECTED",
      crossOrigin.status === 403 && code(crossOrigin) === "CSRF_REJECTED",
      `${crossOrigin.status} ${code(crossOrigin)}`,
    );
    check("same-origin control upload still refused as duplicate", csrf.status === 409);

    /* ---------------------------------------------------------------- */
    /* 5. RBAC / IDOR                                                    */
    /* ---------------------------------------------------------------- */
    console.log("\n— RBAC & IDOR —");
    const cList = await c.get("/api/candidate/documents");
    const cRows = ((cList.body.data as { documents: Json[] }).documents) ?? [];
    check(
      "other candidate's list is empty (no leak)",
      cList.status === 200 && cRows.length === 0,
      `${cList.status} rows=${cRows.length}`,
    );

    const cDetail = await c.get(`/api/candidate/documents/${doc.id}`);
    check(
      "other candidate's detail → 404",
      cDetail.status === 404 && code(cDetail) === "DOCUMENT_NOT_FOUND",
      `${cDetail.status} ${code(cDetail)}`,
    );

    const cFile = await c.get(`/api/candidate/documents/${doc.id}/file`);
    check("other candidate's file → 404", cFile.status === 404, String(cFile.status));

    const aClaim = await a.post("/api/verifier/documents/" + doc.id + "/claim", {});
    check(
      "candidate cannot claim → 403 FORBIDDEN",
      aClaim.status === 403 && code(aClaim) === "FORBIDDEN",
      `${aClaim.status} ${code(aClaim)}`,
    );

    const aVerifierList = await a.get("/api/verifier/documents");
    check(
      "candidate blocked from verifier document API → 403",
      aVerifierList.status === 403 && code(aVerifierList) === "FORBIDDEN",
      `${aVerifierList.status} ${code(aVerifierList)}`,
    );

    const mVerifierList = await m.get("/api/verifier/documents");
    check(
      "admin excluded from document API → 403",
      mVerifierList.status === 403 && code(mVerifierList) === "FORBIDDEN",
      `${mVerifierList.status} ${code(mVerifierList)}`,
    );

    const vCandidateList = await v.get("/api/candidate/documents");
    check(
      "verifier blocked from candidate document API → 403",
      vCandidateList.status === 403 && code(vCandidateList) === "FORBIDDEN",
      `${vCandidateList.status} ${code(vCandidateList)}`,
    );

    const smuggled = await v.post(`/api/verifier/documents/${doc.id}/claim`, { status: "VERIFIED" });
    check(
      "claim with smuggled status → 400 (strict schema)",
      smuggled.status === 400 && code(smuggled) === "VALIDATION_ERROR",
      `${smuggled.status} ${code(smuggled)}`,
    );

    /* ---------------------------------------------------------------- */
    /* 6. Verifier queue, claim, verify                                  */
    /* ---------------------------------------------------------------- */
    console.log("\n— claim & verify —");
    const queue = await v.get("/api/verifier/documents");
    check(
      "verifier queue shows the candidate's e-mail",
      queue.status === 200 && queue.text.includes(a.email),
      `${queue.status}`,
    );

    const claim = await v.post(`/api/verifier/documents/${doc.id}/claim`, {});
    must("claim → 200 UNDER_REVIEW", claim.status === 200, claim.text);
    const claimed = (claim.body.data as { document: { status: string } }).document;
    check("claim moves the row to UNDER_REVIEW", claimed.status === "UNDER_REVIEW", claimed.status);

    const claimAgain = await v.post(`/api/verifier/documents/${doc.id}/claim`, {});
    check(
      "second claim → 409 DOCUMENT_NOT_PENDING",
      claimAgain.status === 409 && code(claimAgain) === "DOCUMENT_NOT_PENDING",
      `${claimAgain.status} ${code(claimAgain)}`,
    );

    const verify = await v.post(`/api/verifier/documents/${doc.id}/verify`, {});
    must("verify → 200 VERIFIED", verify.status === 200, verify.text);

    const verifyAgain = await v.post(`/api/verifier/documents/${doc.id}/verify`, {});
    check(
      "re-verify a verified document → 409 DOCUMENT_FINALIZED",
      verifyAgain.status === 409 && code(verifyAgain) === "DOCUMENT_FINALIZED",
      `${verifyAgain.status} ${code(verifyAgain)}`,
    );

    const reUpload = await a.postForm(
      "/api/candidate/documents",
      uploadForm(certification.id, "ID_PROOF", SCAN_FILE()),
    );
    check(
      "same type after VERIFIED → 409 DOCUMENT_EXISTS",
      reUpload.status === 409 && code(reUpload) === "DOCUMENT_EXISTS",
      `${reUpload.status} ${code(reUpload)}`,
    );

    const verifiedDetail = await a.get(`/api/candidate/documents/${doc.id}`);
    const verifiedBody = verifiedDetail.body.data as { document: Json };
    check(
      "verified detail: reviewedAt set, rejectionReason null",
      verifiedDetail.status === 200 &&
        verifiedBody.document.reviewedAt !== null &&
        verifiedBody.document.rejectionReason === null,
      verifiedDetail.status === 200 ? JSON.stringify(verifiedBody.document) : verifiedDetail.text,
    );

    /* ---------------------------------------------------------------- */
    /* 7. Self-review guard (promote the owner, then demote)             */
    /* ---------------------------------------------------------------- */
    console.log("\n— self-review guard —");
    await prisma.user.update({ where: { id: aId }, data: { role: "VERIFIER" } });
    const selfClaim = await a.post(`/api/verifier/documents/${addressDoc.id}/claim`, {});
    check(
      "owner promoted to verifier still cannot act on their own upload → 403 DOCUMENT_SELF_REVIEW",
      selfClaim.status === 403 && code(selfClaim) === "DOCUMENT_SELF_REVIEW",
      `${selfClaim.status} ${code(selfClaim)}`,
    );
    await prisma.user.update({ where: { id: aId }, data: { role: "CANDIDATE" } });

    /* ---------------------------------------------------------------- */
    /* 8. Rejection + replacement                                        */
    /* ---------------------------------------------------------------- */
    console.log("\n— rejection & replacement —");
    const shortReason = await v.post(`/api/verifier/documents/${addressDoc.id}/reject`, {
      rejectionReason: "blurry",
    });
    check(
      "too-short rejection reason → 400",
      shortReason.status === 400,
      String(shortReason.status),
    );

    const reject = await v.post(`/api/verifier/documents/${addressDoc.id}/reject`, {
      rejectionReason: REASON,
    });
    must("valid rejection → 200 REJECTED", reject.status === 200, reject.text);

    const rejectedDetail = await a.get(`/api/candidate/documents/${addressDoc.id}`);
    const rejectedDocument = (rejectedDetail.body.data as { document: Json }).document;
    check(
      "candidate reads back the rejection reason",
      rejectedDocument.rejectionReason === REASON,
      JSON.stringify(rejectedDocument.rejectionReason),
    );

    const replacement = await a.postForm(
      "/api/candidate/documents",
      uploadForm(certification.id, "ADDRESS_PROOF", SCAN_FILE()),
    );
    check(
      "replacement after REJECTED → 201 PENDING",
      replacement.status === 201 &&
        ((replacement.body.data as { document: { status: string } }).document.status === "PENDING"),
      `${replacement.status} ${replacement.text}`,
    );

    /* ---------------------------------------------------------------- */
    /* 9. Pages                                                          */
    /* ---------------------------------------------------------------- */
    console.log("\n— pages —");
    const candidateListPage = await a.get("/candidate/documents");
    const listHtml = candidateListPage.text;
    check(
      "candidate documents page renders (200, title, skill, upload panel)",
      candidateListPage.status === 200 &&
        listHtml.includes("My documents") &&
        listHtml.includes("Smoke React") &&
        listHtml.includes("Upload a document"),
      String(candidateListPage.status),
    );

    const candidateDetailPage = await a.get(`/candidate/documents/${doc.id}`);
    check(
      "candidate document detail renders the file",
      candidateDetailPage.status === 200 && candidateDetailPage.text.includes("identity-proof.pdf"),
      String(candidateDetailPage.status),
    );

    const aVerifierPage = await a.fetch("/verifier/documents");
    const aVerifierLoc = aVerifierPage.headers.get("location") ?? "";
    check(
      "candidate blocked from verifier page → /unauthorized",
      aVerifierPage.status >= 300 &&
        aVerifierPage.status < 400 &&
        aVerifierLoc.includes("/unauthorized"),
      `${aVerifierPage.status} → ${aVerifierLoc}`,
    );

    const verifierQueuePage = await v.get("/verifier/documents");
    check(
      "verifier queue page renders with the candidate's e-mail",
      verifierQueuePage.status === 200 &&
        verifierQueuePage.text.includes("Document review") &&
        verifierQueuePage.text.includes(a.email),
      String(verifierQueuePage.status),
    );

    const verifierDetailPage = await v.get(`/verifier/documents/${doc.id}`);
    check(
      "verifier document detail renders the decision panel",
      verifierDetailPage.status === 200 &&
        verifierDetailPage.text.includes("Your decision") &&
        verifierDetailPage.text.includes("Download the file"),
      String(verifierDetailPage.status),
    );

    const vCandidatePage = await v.fetch("/candidate/documents");
    const vCandidateLoc = vCandidatePage.headers.get("location") ?? "";
    check(
      "verifier blocked from candidate page → /unauthorized",
      vCandidatePage.status >= 300 &&
        vCandidatePage.status < 400 &&
        vCandidateLoc.includes("/unauthorized"),
      `${vCandidatePage.status} → ${vCandidateLoc}`,
    );

    /* ---------------------------------------------------------------- */
    /* 10. Downloads                                                     */
    /* ---------------------------------------------------------------- */
    console.log("\n— downloads —");
    const candidateFile = await a.fetch(`/api/candidate/documents/${doc.id}/file`);
    const candidateBytes = new Uint8Array(await candidateFile.arrayBuffer());
    const disposition = candidateFile.headers.get("content-disposition") ?? "";
    const csp = candidateFile.headers.get("content-security-policy") ?? "";
    check(
      "candidate download: 200 + attachment + nosniff + no-store + sandbox CSP",
      candidateFile.status === 200 &&
        disposition.includes("attachment") &&
        disposition.includes("identity-proof.pdf") &&
        candidateFile.headers.get("x-content-type-options") === "nosniff" &&
        (candidateFile.headers.get("cache-control") ?? "").includes("no-store") &&
        csp.includes("default-src 'none'"),
      `${candidateFile.status} ${disposition}`,
    );
    check(
      "downloaded bytes equal the uploaded file",
      candidateBytes.length === SCAN_BYTES.length &&
        candidateBytes.every((byte, index) => byte === SCAN_BYTES[index]),
      `${candidateBytes.length} bytes`,
    );

    const verifierFile = await v.fetch(`/api/verifier/documents/${doc.id}/file`);
    check("verifier download → 200", verifierFile.status === 200, String(verifierFile.status));

    /* ---------------------------------------------------------------- */
    /* 11. Audit trail                                                   */
    /* ---------------------------------------------------------------- */
    console.log("\n— audit —");
    const docAudit = await prisma.auditLog.findMany({
      where: { entityId: doc.id },
      orderBy: { createdAt: "asc" },
    });
    const actions = docAudit.map((row) => row.action);
    check(
      "audit holds UPLOADED → REVIEW_STARTED → VERIFIED",
      actions.includes("DOCUMENT_UPLOADED") &&
        actions.includes("DOCUMENT_REVIEW_STARTED") &&
        actions.includes("DOCUMENT_VERIFIED"),
      actions.join(","),
    );
    check(
      "upload audit attributed to the candidate, decisions to the verifier",
      docAudit.some((row) => row.action === "DOCUMENT_UPLOADED" && row.actorId === aId) &&
        docAudit.some((row) => row.action === "DOCUMENT_VERIFIED" && row.actorId === vId),
    );
    check("audit metadata never carries the original filename", !docAudit.some((row) => JSON.stringify(row.metadata).includes("identity-proof.pdf")));

    const rejectedAudit = await prisma.auditLog.findMany({
      where: { entityId: addressDoc.id },
      orderBy: { createdAt: "asc" },
    });
    const rejectedActions = rejectedAudit.map((row) => row.action);
    const reviewStart = rejectedAudit.find((row) => row.action === "DOCUMENT_REVIEW_STARTED");
    const rejection = rejectedAudit.find((row) => row.action === "DOCUMENT_REJECTED");
    check(
      "rejection is preceded by a review start marked implicit",
      rejectedActions.includes("DOCUMENT_REVIEW_STARTED") &&
        rejectedActions.includes("DOCUMENT_REJECTED") &&
        reviewStart !== undefined &&
        JSON.stringify(reviewStart.metadata).includes("implicit") &&
        rejection !== undefined &&
        new Date(reviewStart.createdAt).getTime() <= new Date(rejection.createdAt).getTime(),
      rejectedActions.join(","),
    );
    check(
      "rejection reason text is absent from audit metadata",
      !rejectedAudit.some((row) => JSON.stringify(row.metadata).includes(REASON)),
    );

    /* ---------------------------------------------------------------- */
    /* 12. Storage layout                                                */
    /* ---------------------------------------------------------------- */
    console.log("\n— storage —");
    const stored = await prisma.document.findUnique({ where: { id: doc.id } });
    must("document row persisted", stored !== null);
    const storedPath = join(STORAGE_DIR, stored!.storedFileName as string);
    check(
      "stored file exists under storage/documents (outside public/)",
      existsSync(storedPath) && !existsSync(join(ROOT, "public", "storage", "documents")),
      storedPath,
    );
    storedFiles.push(storedPath);
    const replacementRow = await prisma.document.findUnique({
      where: { id: (replacement.body.data as { document: { id: string } }).document.id },
    });
    if (replacementRow?.storedFileName) {
      storedFiles.push(join(STORAGE_DIR, replacementRow.storedFileName));
    }

    /* ---------------------------------------------------------------- */
    /* 13. Finalised request refuses new documents                       */
    /* ---------------------------------------------------------------- */
    console.log("\n— finalized request —");
    const approve = await v.post(`/api/verifier/certifications/${certification.id}/approve`, {});
    must("Module 4 approval succeeds (200)", approve.status === 200, approve.text);

    const late = await a.postForm(
      "/api/candidate/documents",
      uploadForm(certification.id, "EXPERIENCE_PROOF", SCAN_FILE()),
    );
    check(
      "upload on an approved request → 409 DOCUMENT_CERTIFICATION_NOT_ELIGIBLE",
      late.status === 409 && code(late) === "DOCUMENT_CERTIFICATION_NOT_ELIGIBLE",
      `${late.status} ${code(late)}`,
    );
  } finally {
    /* ---------------------------------------------------------------- */
    /* Cleanup: files, rows, server — restore the baseline exactly       */
    /* ---------------------------------------------------------------- */
    console.log("\n— cleanup —");
    for (const file of storedFiles) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch (error) {
        console.warn(`could not remove ${file}: ${(error as Error).message}`);
      }
    }

    const docs = await prisma.document.findMany({
      where: { certificationId: { in: smokeIds.certifications } },
      select: { id: true, storedFileName: true },
    });
    for (const row of docs) {
      const path = join(STORAGE_DIR, row.storedFileName);
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch (error) {
        console.warn(`could not remove ${path}: ${(error as Error).message}`);
      }
    }
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { actorId: { in: smokeIds.users } },
          { entityId: { in: [...smokeIds.users, ...smokeIds.skills, ...smokeIds.certifications, ...docs.map((row) => row.id)] } },
        ],
      },
    });
    await prisma.document.deleteMany({ where: { certificationId: { in: smokeIds.certifications } } });
    await prisma.certification.deleteMany({ where: { id: { in: smokeIds.certifications } } });
    await prisma.skill.deleteMany({ where: { id: { in: smokeIds.skills } } });
    await prisma.eKYCVerification.deleteMany({ where: { userId: { in: smokeIds.users } } });
    await prisma.user.deleteMany({ where: { id: { in: smokeIds.users } } });

    const after = {
      users: await prisma.user.count(),
      skills: await prisma.skill.count(),
      certifications: await prisma.certification.count(),
      documents: await prisma.document.count(),
      audits: await prisma.auditLog.count(),
    };
    check("database restored to its baseline", JSON.stringify(after) === JSON.stringify(baseline), `${JSON.stringify(after)} vs ${JSON.stringify(baseline)}`);

    stopServer();
    console.log("server stopped");
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(`\nFATAL: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

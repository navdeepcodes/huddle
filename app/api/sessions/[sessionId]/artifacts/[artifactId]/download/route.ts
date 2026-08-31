import { NextRequest, NextResponse } from "next/server";

import { getVerifiedUid } from "@/lib/auth/verifyRequest";
import { requireSessionMember } from "@/lib/auth/requireSessionMember";
import { getArtifact } from "@/lib/artifacts/artifactStore";
import { readSessionFile } from "@/lib/files/fileStore";

interface Props {
  params: Promise<{ sessionId: string; artifactId: string }>;
}

const CONTENT_TYPE: Record<string, string> = {
  presentation: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function safeFilename(title: string, extension: string): string {
  const base = title.trim().replace(/[^a-zA-Z0-9 _-]/g, "").trim().replace(/\s+/g, "-") || "artifact";
  return `${base}.${extension}`;
}

/** Phase 35: the artifact's real bytes live in sessionFiles (the same store write_file already uses) - this route reads that file by the artifact's own `path`, decodes it, and serves it with real download headers. Same membership gate as every other session-scoped route; no separate artifact-permission system. */
export async function GET(request: NextRequest, { params }: Props) {
  const { sessionId, artifactId } = await params;
  const uid = await getVerifiedUid(request);
  if (!uid) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const session = await requireSessionMember(sessionId, uid);
  if (!session) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const artifact = await getArtifact(sessionId, artifactId);
  if (!artifact) {
    return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
  }
  if (artifact.status !== "ready") {
    return NextResponse.json({ error: `Artifact isn't ready yet (status: ${artifact.status}).` }, { status: 409 });
  }

  const file = await readSessionFile(sessionId, artifact.path);
  if (!file) {
    return NextResponse.json({ error: "The artifact's file is missing." }, { status: 404 });
  }

  const bytes = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
  const filename = safeFilename(artifact.title, artifact.path.split(".").pop() ?? "pptx");

  return new NextResponse(bytes, {
    headers: {
      "Content-Type": CONTENT_TYPE[artifact.type] ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bytes.length),
    },
  });
}

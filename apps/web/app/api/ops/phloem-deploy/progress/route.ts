import { NextResponse } from "next/server";

import type { CompletedPhloemUpload } from "../../../../../lib/phloem-deployment-types";
import { recordPhloemUploadProgress } from "../../../../../lib/server/phloem-deployment";

export const runtime = "nodejs";

interface ProgressInput {
  address: string;
  results: CompletedPhloemUpload[];
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as ProgressInput;
    const recorded = await recordPhloemUploadProgress(input.address, input.results);
    return NextResponse.json(recorded, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Phloem upload progress could not be recorded.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}

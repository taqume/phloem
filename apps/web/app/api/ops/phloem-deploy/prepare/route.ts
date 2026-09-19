import { NextResponse } from "next/server";

import {
  preparePhloemUpload,
  type PreparePhloemUploadInput,
} from "../../../../../lib/server/phloem-deployment";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as PreparePhloemUploadInput;
    const prepared = await preparePhloemUpload(input);
    return NextResponse.json(prepared, { headers: { "cache-control": "no-store" } });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Phloem upload preparation failed.";
    return NextResponse.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}

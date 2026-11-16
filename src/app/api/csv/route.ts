import { NextResponse } from "next/server";
import { analyzeCsvFile, listCsvFiles, saveUploadedCsv } from "@/lib/server/csv";
import { InputError } from "@/lib/server/errors";
import { body, handle } from "@/lib/server/http";
import { boot } from "@/lib/server/service";

export async function GET(request: Request) {
  return handle(async () => {
    await boot();
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    if (path) {
      return { files: listCsvFiles(), report: analyzeCsvFile(path) };
    }
    return { files: listCsvFiles() };
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    await boot();
    const contentType = request.headers.get("content-type") || "";
    let filename = "upload.csv";
    let csvText = "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new InputError("Expected a CSV file field named `file`.");
      }
      filename = file.name || "upload.csv";
      csvText = await file.text();
    } else {
      const data = await body<{ filename?: string; content?: string }>(request);
      if (typeof data.content !== "string") {
        throw new InputError("Expected { filename, content } or multipart CSV upload.");
      }
      filename = data.filename || "upload.csv";
      csvText = data.content;
    }

    const { path, report } = saveUploadedCsv(filename, csvText);
    return NextResponse.json({ path, report }, { status: 201 });
  });
}

import { describe, expect, it } from "vitest";

import { readCsv } from "../src/timetable-pack/csv";

const rowsOf = (text: string): Record<string, string>[] => {
  const out: Record<string, string>[] = [];
  readCsv(text, (get, columns) => {
    out.push(Object.fromEntries(columns.map((c) => [c, get(c)])));
  });
  return out;
};

describe("readCsv", () => {
  it("見出し行の列名で各行の値を引ける", () => {
    expect(rowsOf("a,b\n1,2\n3,4\n")).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("先頭の BOM を列名に含めない", () => {
    expect(rowsOf("﻿trip_id,stop_id\nT1,S1\n")).toEqual([
      { trip_id: "T1", stop_id: "S1" },
    ]);
  });

  it("CRLF の改行を値に残さない", () => {
    expect(rowsOf("a,b\r\n1,2\r\n")).toEqual([{ a: "1", b: "2" }]);
  });

  it("引用符で囲んだ値のカンマ・改行・二重引用符を値として読む", () => {
    expect(rowsOf('a,b\n"x,y","say ""hi""\nbye"\n')).toEqual([
      { a: "x,y", b: 'say "hi"\nbye' },
    ]);
  });

  it("末尾に改行が無い最終行も読む", () => {
    expect(rowsOf("a\n1")).toEqual([{ a: "1" }]);
  });

  it("空行を飛ばす", () => {
    expect(rowsOf("a\n1\n\n2\n")).toEqual([{ a: "1" }, { a: "2" }]);
  });

  it("見出しに無い列は空文字として引ける", () => {
    const got: string[] = [];
    readCsv("a\n1\n", (get) => got.push(get("missing")));
    expect(got).toEqual([""]);
  });

  it("行の値が足りない列は空文字として引ける", () => {
    expect(rowsOf("a,b,c\n1\n")).toEqual([{ a: "1", b: "", c: "" }]);
  });
});

const { TextSplitter } = require("../../../utils/TextSplitter");

const THAI_PARAGRAPH =
  "ระเบียบกระทรวงการคลังว่าด้วยการจัดซื้อจัดจ้างและการบริหารพัสดุภาครัฐกำหนดให้" +
  "หน่วยงานของรัฐจัดทำแผนการจัดซื้อจัดจ้างประจำปีและประกาศเผยแพร่ในระบบเครือข่าย" +
  "สารสนเทศของกรมบัญชีกลางเพื่อให้ผู้ประกอบการทุกรายเข้าถึงข้อมูลได้อย่างเท่าเทียมกัน";

function wordBoundaryOffsets(text) {
  const segmenter = new Intl.Segmenter("th", { granularity: "word" });
  const offsets = new Set([0]);
  for (const { segment, index } of segmenter.segment(text))
    offsets.add(index + segment.length);
  return offsets;
}

describe("TextSplitter Thai word boundaries", () => {
  test("does not cut a Thai paragraph in the middle of a word", async () => {
    const splitter = new TextSplitter({ chunkSize: 80, chunkOverlap: 0 });
    const chunks = await splitter.splitText(THAI_PARAGRAPH);
    const boundaries = wordBoundaryOffsets(THAI_PARAGRAPH);

    expect(chunks.length).toBeGreaterThan(1);
    let cursor = 0;
    for (const chunk of chunks) {
      const start = THAI_PARAGRAPH.indexOf(chunk, cursor);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(boundaries.has(start)).toBe(true);
      expect(boundaries.has(start + chunk.length)).toBe(true);
      cursor = start + chunk.length;
    }
  });

  test("emits no zero width space in Thai chunks", async () => {
    const splitter = new TextSplitter({ chunkSize: 80, chunkOverlap: 0 });
    const chunks = await splitter.splitText(THAI_PARAGRAPH);
    expect(chunks.some((chunk) => chunk.includes("​"))).toBe(false);
  });

  test("respects the max chunk size for Thai text", async () => {
    const splitter = new TextSplitter({ chunkSize: 80, chunkOverlap: 0 });
    const chunks = await splitter.splitText(THAI_PARAGRAPH);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
  });

  test("keeps English output identical to the character splitter", async () => {
    const text = "This is a test text to be split into chunks".repeat(6);
    const splitter = new TextSplitter({ chunkSize: 50, chunkOverlap: 10 });
    const {
      RecursiveCharacterTextSplitter,
    } = require("@langchain/textsplitters");
    const baseline = await new RecursiveCharacterTextSplitter({
      chunkSize: 50,
      chunkOverlap: 10,
    }).splitText(text);
    expect(await splitter.splitText(text)).toEqual(baseline);
  });

  test("splits mixed Thai and English on Thai word boundaries", async () => {
    const mixed =
      "ระบบคอมพิวเตอร์ของหน่วยงานต้องรองรับ Unicode และภาษาไทยอย่างสมบูรณ์ " +
      "the vendor must supply a maintenance contract ตามเงื่อนไขในสัญญาจัดซื้อ";
    const splitter = new TextSplitter({ chunkSize: 60, chunkOverlap: 0 });
    const chunks = await splitter.splitText(mixed);
    const boundaries = wordBoundaryOffsets(mixed);
    for (const chunk of chunks) {
      const start = mixed.indexOf(chunk);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(boundaries.has(start + chunk.length)).toBe(true);
    }
  });
});

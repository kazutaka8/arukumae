/**
 * 木の判定を Claude に頼む（F6・F7、spec §8.4）。試し（experiments/case_c/run.py）の問いかけと答えの形をそのまま移した。
 *
 * - 鍵は利用者のもの。このブラウザから Anthropic に直接送り、作り手のサーバーは通らない（spec §12）
 * - 送るのは航空写真の切り抜き2枚と区切りの番号だけ。座標・地名・案件名は送らない（spec §8.7）
 * - 答えは json_schema で形を固め、tree は 0・25・50・75・100 のどれかにする
 */
import Anthropic from "@anthropic-ai/sdk";
import type { WindowImages } from "./photo";
import type { Confidence, Judgment, TreeKind } from "./types";

export const MODELS = {
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-fable-5-1": "Claude Fable 5.1",
} as const;
export type ModelId = keyof typeof MODELS;

/** 料金（$／100万トークン、入力・出力）。2026-10 時点の表。費用の目安を出すためだけに使う */
const PRICE: Record<ModelId, [number, number]> = {
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
  "claude-fable-5-1": [10, 50],
};

/** 1窓（40区切り）あたりのトークンの目安。試し（spec §15）の実測：入力 3.9〜4.6k、出力 2.2〜3.5k */
const TOKENS_PER_WINDOW = { in: 4300, out: 2400 };
/** 見直しは区切りを絞るので出力が少ない。確信「低」は試しで 13〜17% だったので、窓の半分に見直しが出ると見る */
const REVIEW = { in: 4300, out: 800, windowRate: 0.5 };

const KINDS: TreeKind[] = ["針葉樹", "広葉樹", "混じる", "分からない", "なし"];
const OTHERS = ["道路", "草地", "畑", "建物", "設備", "水", "裸地"];

const SYSTEM = `あなたは、道路沿いの土地の下調べを手伝います。目的は、大型車両の通行に向けて木を切ることになりそうな所を、現地を歩く前に洗い出すことです。最後に決めるのは人で、あなたの判定は現地で確かめる前の候補として使われます。

渡すもの：
- 1枚目：航空写真（真上から。約 0.5m／画素の写真を3倍に拡大したもの）
- 2枚目：同じ範囲に、道路沿いの「区切り」の枠と番号を描いたもの。区切りは道路の端から外側へ幅10mほど、道に沿って10mずつ。黄色の枠が進行方向の左（L）、水色の枠が右（R）

地面の様子は1枚目で見て、区切りの位置と番号は2枚目で対応させてください。枠や番号が地面を隠している所は、1枚目で確かめてください。

区切りごとに答えること：
- tree：区切りの面積のうち、木の樹冠に覆われている割合（0・25・50・75・100 のどれか）
- kind：樹冠の種類（針葉樹・広葉樹・混じる・分からない。木がなければ「なし」）
- other：木のほかに区切りに写っているもの（道路・草地・畑・建物・設備・水・裸地。なければ空）
- conf：判定の確信（高・中・低）。写真がぼやけている、影で見えない、枠の位置が読み取りにくい、などのときは「低」
- why：判定の理由を、日本語で短く

木の高さは写真からは分からないので、考えに入れないでください。迷ったら、木がある側に倒し、確信を下げてください（見落としより、現地で確かめる所が増えるほうがよい）。
指定した番号には、すべて1回ずつ答えてください。`;

function schema(ids: string[]) {
  return {
    type: "object",
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", enum: ids },
            tree: { type: "integer", enum: [0, 25, 50, 75, 100] },
            kind: { type: "string", enum: KINDS },
            other: { type: "array", items: { type: "string", enum: OTHERS } },
            conf: { type: "string", enum: ["高", "中", "低"] },
            why: { type: "string" },
          },
          required: ["id", "tree", "kind", "other", "conf", "why"],
          additionalProperties: false,
        },
      },
    },
    required: ["segments"],
    additionalProperties: false,
  };
}

export interface JudgeResult {
  judgments: Judgment[];
  model: string;
  seconds: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  refused: boolean;
}

export function makeClient(apiKey: string): Anthropic {
  // 鍵をブラウザに置くのは、利用者が自分の鍵を自分の端末で使う作りだから（spec §12）。SDK の警告はそのための明示
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

/**
 * 1窓を判定する。ids を絞れば、同じ写真でその区切りだけ答えさせる（見直しに使う）。
 * 見直しのときに最初の判定を添えないのは、添えると引きずられて「別のモデルの目」にならないため。
 */
export async function judgeWindow(client: Anthropic, model: ModelId, images: WindowImages, ids: string[] = images.ids): Promise<JudgeResult> {
  const t0 = performance.now();
  const msg = await client.beta.messages
    .stream({
      model,
      max_tokens: 32000,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "1枚目（札なし）" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: images.plain } },
            { type: "text", text: "2枚目（区切りの枠と番号）" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: images.labeled } },
            { type: "text", text: "判定する区切り：" + ids.join("、") },
          ],
        },
      ],
      output_config: { effort: "medium", format: { type: "json_schema", schema: schema(ids) } },
      // 混んでいて断られたときに別のモデルで続ける。どのモデルが答えたかは usage に残る
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    })
    .finalMessage();
  const seconds = (performance.now() - t0) / 1000;
  const [pin, pout] = PRICE[model];
  const usd = (msg.usage.input_tokens * pin + msg.usage.output_tokens * pout) / 1e6;
  const refused = msg.stop_reason === "refusal";
  let judgments: Judgment[] = [];
  if (!refused) {
    const text = msg.content.find((b) => b.type === "text")?.text ?? "{}";
    const parsed = JSON.parse(text) as { segments: { id: string; tree: number; kind: TreeKind; other: string[]; conf: Confidence; why: string }[] };
    judgments = parsed.segments
      .filter((s) => ids.includes(s.id))
      .map((s) => ({ segmentId: s.id, tree: s.tree, kind: s.kind, other: s.other, conf: s.conf, why: s.why, by: "Claude", model }));
  }
  return { judgments, model, seconds, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, usd, refused };
}

/** 押す前に出す費用の目安（$）。spec §6.1「費用がかかる操作は、押す前に目安を出す」 */
export function estimateCost(nWindows: number, model: ModelId, review: ModelId | ""): number {
  const [pin, pout] = PRICE[model];
  let usd = (nWindows * (TOKENS_PER_WINDOW.in * pin + TOKENS_PER_WINDOW.out * pout)) / 1e6;
  if (review) {
    const [rin, rout] = PRICE[review];
    usd += (nWindows * REVIEW.windowRate * (REVIEW.in * rin + REVIEW.out * rout)) / 1e6;
  }
  return usd;
}

export function fmtUsd(usd: number): string {
  return usd < 0.1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

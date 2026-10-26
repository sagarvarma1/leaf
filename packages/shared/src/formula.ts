/**
 * Database formulas: a small expression language in the spirit of Notion's.
 *
 *   prop("Points") * 2
 *   if(prop("Shipped"), "✅ shipped", "⏳ " + prop("Status"))
 *   dateBetween(prop("Due"), today(), "days")
 *
 * Parsed by a Pratt parser into an AST and evaluated against one row. Never `eval`: the
 * expression comes from any workspace member and runs in every collaborator's browser.
 */

export type FormulaValue = number | string | boolean | Date | FormulaValue[] | null;

export type Ast =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "prop"; name: string }
  | { k: "call"; fn: string; args: Ast[] }
  | { k: "unary"; op: string; arg: Ast }
  | { k: "binary"; op: string; left: Ast; right: Ast };

export class FormulaError extends Error {}

// ---------------------------------------------------------------- tokenizer

type Tok = { t: "num"; v: number } | { t: "str"; v: string } | { t: "id"; v: string } | { t: "op"; v: string } | { t: "eof" };

const OPS = ["==", "!=", ">=", "<=", "&&", "||", "+", "-", "*", "/", "%", "^", ">", "<", "!", "(", ")", ","];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new FormulaError(`Unexpected "${c}"`);
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'" || c === "“") {
      const close = c === "“" ? "”" : c;
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== close) {
        if (src[j] === "\\" && j + 1 < src.length) j++;
        s += src[j];
        j++;
      }
      if (j >= src.length) throw new FormulaError("Unclosed string");
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaError(`Unexpected "${c}"`);
    out.push({ t: "op", v: op });
    i += op.length;
  }
  out.push({ t: "eof" });
  return out;
}

// ---------------------------------------------------------------- parser

const BINARY: Record<string, number> = {
  "||": 1,
  or: 1,
  "&&": 2,
  and: 2,
  "==": 3,
  "!=": 3,
  ">": 4,
  "<": 4,
  ">=": 4,
  "<=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
  "^": 7,
};

export function parseFormula(src: string): Ast {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos]!;
  const next = () => toks[pos++]!;
  const expectOp = (v: string) => {
    const t = next();
    if (t.t !== "op" || t.v !== v) throw new FormulaError(`Expected "${v}"`);
  };
  const binOp = (t: Tok): string | null => {
    if (t.t === "op" && t.v in BINARY) return t.v;
    if (t.t === "id" && (t.v === "and" || t.v === "or")) return t.v;
    return null;
  };

  const primary = (): Ast => {
    const t = next();
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "str") return { k: "str", v: t.v };
    if (t.t === "op" && t.v === "(") {
      const e = expr(0);
      expectOp(")");
      return e;
    }
    if (t.t === "op" && (t.v === "-" || t.v === "!")) return { k: "unary", op: t.v, arg: expr(8) };
    if (t.t === "id") {
      if (t.v === "true" || t.v === "false") return { k: "bool", v: t.v === "true" };
      if (t.v === "not") return { k: "unary", op: "!", arg: expr(8) };
      const n = peek();
      if (n.t !== "op" || n.v !== "(") throw new FormulaError(`Unknown name "${t.v}"`);
      next();
      const args: Ast[] = [];
      if (!(peek().t === "op" && (peek() as any).v === ")")) {
        args.push(expr(0));
        while (peek().t === "op" && (peek() as any).v === ",") {
          next();
          args.push(expr(0));
        }
      }
      expectOp(")");
      if (t.v === "prop") {
        if (args.length !== 1 || args[0]!.k !== "str") throw new FormulaError('prop() takes a property name, like prop("Points")');
        return { k: "prop", name: args[0]!.v as string };
      }
      if (!(t.v in FUNCTIONS)) throw new FormulaError(`Unknown function ${t.v}()`);
      return { k: "call", fn: t.v, args };
    }
    if (t.t === "eof") throw new FormulaError("Unexpected end of formula");
    throw new FormulaError(`Unexpected "${(t as any).v}"`);
  };

  const expr = (minPrec: number): Ast => {
    let left = primary();
    for (;;) {
      const op = binOp(peek());
      if (!op) break;
      const prec = BINARY[op]!;
      if (prec < minPrec) break;
      next();
      // ^ is right-associative; everything else is left-associative.
      const right = expr(op === "^" ? prec : prec + 1);
      left = { k: "binary", op: op === "and" ? "&&" : op === "or" ? "||" : op, left, right };
    }
    return left;
  };

  const ast = expr(0);
  if (peek().t !== "eof") throw new FormulaError(`Unexpected "${(peek() as any).v}"`);
  return ast;
}

/** Property names a formula reads (for dependency display and rename rewrites). */
export function formulaProps(ast: Ast): string[] {
  const out = new Set<string>();
  const walk = (a: Ast) => {
    if (a.k === "prop") out.add(a.name);
    else if (a.k === "call") a.args.forEach(walk);
    else if (a.k === "unary") walk(a.arg);
    else if (a.k === "binary") (walk(a.left), walk(a.right));
  };
  walk(ast);
  return [...out];
}

/** Rewrite prop("old") to prop("new") after a property rename. */
export function renameFormulaProp(src: string, from: string, to: string): string {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return src.replace(new RegExp(`prop\\(\\s*(["'])${esc}\\1\\s*\\)`, "g"), `prop("${to.replace(/"/g, '\\"')}")`);
}

// ---------------------------------------------------------------- evaluation

const DAY = 86_400_000;
const isDate = (v: unknown): v is Date => v instanceof Date;

export function toText(v: FormulaValue): string {
  if (v === null) return "";
  if (Array.isArray(v)) return v.map(toText).join(", ");
  if (isDate(v)) return formatDate(v);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  return String(v);
}

const toNum = (v: FormulaValue): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isDate(v)) return v.getTime();
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  if (v === null) return 0;
  throw new FormulaError(`Expected a number, got "${toText(v)}"`);
};
const toBool = (v: FormulaValue): boolean => (Array.isArray(v) ? v.length > 0 : Boolean(v));
const toDate = (v: FormulaValue): Date => {
  if (isDate(v)) return v;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return parseDay(v);
  if (typeof v === "number") return new Date(v);
  throw new FormulaError(`Expected a date, got "${toText(v)}"`);
};
const isEmptyVal = (v: FormulaValue) => v === null || v === "" || (Array.isArray(v) && v.length === 0);

export function parseDay(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function addUnits(d: Date, n: number, unit: string): Date {
  const out = new Date(d);
  switch (unit) {
    case "years":
      out.setFullYear(out.getFullYear() + n);
      break;
    case "months":
      out.setMonth(out.getMonth() + n);
      break;
    case "weeks":
      out.setDate(out.getDate() + n * 7);
      break;
    case "days":
      out.setDate(out.getDate() + n);
      break;
    case "hours":
      out.setTime(out.getTime() + n * 3_600_000);
      break;
    case "minutes":
      out.setTime(out.getTime() + n * 60_000);
      break;
    default:
      throw new FormulaError(`Unknown unit "${unit}"`);
  }
  return out;
}

function between(a: Date, b: Date, unit: string): number {
  const ms = a.getTime() - b.getTime();
  switch (unit) {
    case "years":
      return a.getFullYear() - b.getFullYear() - (a.getMonth() < b.getMonth() || (a.getMonth() === b.getMonth() && a.getDate() < b.getDate()) ? 1 : 0);
    case "months":
      return (a.getFullYear() - b.getFullYear()) * 12 + a.getMonth() - b.getMonth() - (a.getDate() < b.getDate() ? 1 : 0);
    case "weeks":
      return Math.trunc(ms / (7 * DAY));
    case "days":
      return Math.round(ms / DAY);
    case "hours":
      return Math.trunc(ms / 3_600_000);
    case "minutes":
      return Math.trunc(ms / 60_000);
    default:
      throw new FormulaError(`Unknown unit "${unit}"`);
  }
}

const arity = (name: string, args: unknown[], min: number, max = min) => {
  if (args.length < min || args.length > max) throw new FormulaError(`${name}() takes ${min === max ? min : `${min}–${max}`} argument${max === 1 ? "" : "s"}`);
};

type Fn = (args: FormulaValue[], now: Date) => FormulaValue;

const FUNCTIONS: Record<string, Fn> = {
  concat: (a) => a.map(toText).join(""),
  join: (a) => {
    arity("join", a, 1, 99);
    const [sep, ...rest] = a;
    return rest.flatMap((x) => (Array.isArray(x) ? x : [x])).map(toText).join(toText(sep!));
  },
  length: (a) => (arity("length", a, 1), Array.isArray(a[0]) ? a[0].length : toText(a[0]!).length),
  contains: (a) => {
    arity("contains", a, 2);
    const [hay, needle] = a;
    if (Array.isArray(hay)) return hay.some((x) => toText(x) === toText(needle!));
    return toText(hay!).toLowerCase().includes(toText(needle!).toLowerCase());
  },
  lower: (a) => (arity("lower", a, 1), toText(a[0]!).toLowerCase()),
  upper: (a) => (arity("upper", a, 1), toText(a[0]!).toUpperCase()),
  replace: (a) => (arity("replace", a, 3), toText(a[0]!).split(toText(a[1]!)).join(toText(a[2]!))),
  format: (a) => (arity("format", a, 1), toText(a[0]!)),
  toNumber: (a) => {
    arity("toNumber", a, 1);
    const n = Number(toText(a[0]!).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  },
  round: (a) => {
    arity("round", a, 1, 2);
    const p = 10 ** (a[1] === undefined ? 0 : toNum(a[1]));
    return Math.round(toNum(a[0]!) * p) / p;
  },
  floor: (a) => (arity("floor", a, 1), Math.floor(toNum(a[0]!))),
  ceil: (a) => (arity("ceil", a, 1), Math.ceil(toNum(a[0]!))),
  abs: (a) => (arity("abs", a, 1), Math.abs(toNum(a[0]!))),
  sqrt: (a) => (arity("sqrt", a, 1), Math.sqrt(toNum(a[0]!))),
  min: (a) => Math.min(...a.flatMap((x) => (Array.isArray(x) ? x : [x])).map(toNum)),
  max: (a) => Math.max(...a.flatMap((x) => (Array.isArray(x) ? x : [x])).map(toNum)),
  sum: (a) => a.flatMap((x) => (Array.isArray(x) ? x : [x])).reduce<number>((s, x) => s + toNum(x), 0),
  empty: (a) => (arity("empty", a, 1), isEmptyVal(a[0]!)),
  now: (_a, now) => new Date(now),
  today: (_a, now) => new Date(now.getFullYear(), now.getMonth(), now.getDate()),
  dateAdd: (a) => (arity("dateAdd", a, 3), addUnits(toDate(a[0]!), toNum(a[1]!), toText(a[2]!))),
  dateSubtract: (a) => (arity("dateSubtract", a, 3), addUnits(toDate(a[0]!), -toNum(a[1]!), toText(a[2]!))),
  dateBetween: (a) => (arity("dateBetween", a, 3), between(toDate(a[0]!), toDate(a[1]!), toText(a[2]!))),
  formatDate: (a) => (arity("formatDate", a, 1), formatDate(toDate(a[0]!))),
  year: (a) => (arity("year", a, 1), toDate(a[0]!).getFullYear()),
  month: (a) => (arity("month", a, 1), toDate(a[0]!).getMonth() + 1),
  day: (a) => (arity("day", a, 1), toDate(a[0]!).getDate()),
  // if/and/or are short-circuiting and handled in evaluate(); listed so the parser knows them.
  if: () => null,
  and: () => null,
  or: () => null,
  not: () => null,
};

export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS).sort();

/**
 * Evaluate a formula. `prop(name)` is resolved by the caller, which converts stored
 * values into formula values (option names, dates, related titles, other formulas).
 */
export function evaluateFormula(ast: Ast, prop: (name: string) => FormulaValue, now = new Date()): FormulaValue {
  const ev = (a: Ast): FormulaValue => {
    switch (a.k) {
      case "num":
      case "str":
      case "bool":
        return a.v;
      case "prop":
        return prop(a.name);
      case "unary": {
        const v = ev(a.arg);
        return a.op === "-" ? -toNum(v) : !toBool(v);
      }
      case "call": {
        if (a.fn === "if") {
          arity("if", a.args, 3);
          return toBool(ev(a.args[0]!)) ? ev(a.args[1]!) : ev(a.args[2]!);
        }
        if (a.fn === "and") return a.args.every((x) => toBool(ev(x)));
        if (a.fn === "or") return a.args.some((x) => toBool(ev(x)));
        if (a.fn === "not") return (arity("not", a.args, 1), !toBool(ev(a.args[0]!)));
        return FUNCTIONS[a.fn]!(a.args.map(ev), now);
      }
      case "binary": {
        if (a.op === "&&") return toBool(ev(a.left)) && toBool(ev(a.right));
        if (a.op === "||") return toBool(ev(a.left)) || toBool(ev(a.right));
        const l = ev(a.left);
        const r = ev(a.right);
        switch (a.op) {
          case "+":
            if (typeof l === "string" || typeof r === "string" || Array.isArray(l) || Array.isArray(r)) return toText(l) + toText(r);
            if (isDate(l) && typeof r === "number") return addUnits(l, r, "days");
            return toNum(l) + toNum(r);
          case "-":
            if (isDate(l) && isDate(r)) return between(l, r, "days");
            if (isDate(l)) return addUnits(l, -toNum(r), "days");
            return toNum(l) - toNum(r);
          case "*":
            return toNum(l) * toNum(r);
          case "/": {
            const d = toNum(r);
            if (d === 0) throw new FormulaError("Division by zero");
            return toNum(l) / d;
          }
          case "%":
            return toNum(l) % toNum(r);
          case "^":
            return toNum(l) ** toNum(r);
          case "==":
          case "!=": {
            const eq = isDate(l) || isDate(r) ? toDate(l).getTime() === toDate(r).getTime() : toText(l) === toText(r);
            return a.op === "==" ? eq : !eq;
          }
          default: {
            const both = typeof l === "string" && typeof r === "string";
            const x = both ? l : toNum(l);
            const y = both ? r : toNum(r);
            return a.op === ">" ? x > y : a.op === "<" ? x < y : a.op === ">=" ? x >= y : x <= y;
          }
        }
      }
    }
  };
  const out = ev(ast);
  if (typeof out === "number" && !Number.isFinite(out)) throw new FormulaError("Result is not a number");
  return out;
}

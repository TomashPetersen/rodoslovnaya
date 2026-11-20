import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const checkedDirectories = [
  "knowledge",
  "research",
  "plans",
  "retrospectives",
  "scripts",
];
const extraDocuments = ["app/README.md", "research-data/README.md"];
const localArtifacts = ["research-data/apps/", "research-data/downloads/"];
const excludedDirectoryNames = new Set([
  ".git",
  "node_modules",
  "output",
  "dist",
  "test-results",
  "playwright-report",
]);
const blank = (value) => value.replace(/[^\n]/g, " ");

function indentation(text) {
  let columns = 0;
  for (const character of text) {
    if (character === " ") columns += 1;
    else if (character === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

function removeIndent(text, columns) {
  let consumed = 0;
  let index = 0;
  while (consumed < columns && /[ \t]/.test(text[index] ?? "")) {
    consumed += text[index] === "\t" ? 4 - (consumed % 4) : 1;
    index += 1;
  }
  return " ".repeat(Math.max(0, consumed - columns)) + text.slice(index);
}

function quoteContent(line) {
  let depth = 0;
  let content = line;
  let marker;
  while ((marker = content.match(/^ {0,3}>[ \t]?/))) {
    depth += 1;
    content = content.slice(marker[0].length);
  }
  return { depth, content };
}

// Отступ списка сам по себе не превращает вложенную ссылку в блок кода.
// Один разбор ограждений применяется и к ссылкам, и к заголовкам.
function blockLines(source) {
  let fence;
  let quoteDepth = 0;
  let listIndents = [];
  let paragraph = false;
  return source
    .replace(/<!--[\s\S]*?-->/g, blank)
    .split("\n")
    .map((raw) => {
      const quote = quoteContent(raw);
      if (fence) {
        const leftQuote = quote.depth < fence.quoteDepth;
        const leftList =
          quote.depth === fence.quoteDepth &&
          quote.content.trim() &&
          indentation(quote.content) < fence.listIndent;
        if (!leftQuote && !leftList) {
          const content = removeIndent(
            quote.depth === fence.quoteDepth ? quote.content : raw,
            fence.listIndent,
          );
          const marker = content.match(/^ {0,3}(`{3,}|~{3,})/);
          if (
            marker &&
            marker[1][0] === fence.marker[0] &&
            marker[1].length >= fence.marker.length &&
            content.slice(marker[0].length).trim() === ""
          )
            fence = undefined;
          return { raw, text: null };
        }
        fence = undefined;
        paragraph = false;
      }
      if (quote.depth !== quoteDepth) {
        quoteDepth = quote.depth;
        listIndents = [];
        paragraph = false;
      }
      if (!quote.content.trim()) {
        paragraph = false;
        return { raw, text: quote.content };
      }
      const indent = indentation(quote.content);
      while (listIndents.length && indent < listIndents.at(-1))
        listIndents.pop();
      let base = listIndents.at(-1) ?? 0;
      const item = quote.content.match(/^([ \t]*)([-+*]|\d+[.)])([ \t]+)(.*)$/);
      let text;
      if (item && indent - base <= 3) {
        base = indent + item[2].length + indentation(item[3]);
        listIndents.push(base);
        text = item[4];
        paragraph = false;
      } else text = removeIndent(quote.content, base);
      const marker = text.match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker) {
        fence = { marker: marker[1], quoteDepth, listIndent: base };
        paragraph = false;
        return { raw, text: null };
      }
      if (indentation(text) >= 4 && !paragraph) return { raw, text: null };
      paragraph = !/^ {0,3}(?:#{1,6}[ \t]|(?:[-*_][ \t]*){3,}$)/.test(text);
      return { raw, text };
    });
}

// Сохраняем позиции строк, исключая примеры кода из графа настоящих ссылок.
function withoutCode(source) {
  return blockLines(source)
    .map(({ raw, text }) =>
      text === null ? blank(raw) : raw.replace(/(`+)(.*?)\1(?!`)/g, blank),
    )
    .join("\n");
}

function slug(value) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, "")
    .replace(/\s/g, "-");
}

function anchors(source) {
  const found = new Set();
  const counts = new Map();
  const lines = blockLines(source).map(({ text }) => text);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === null) continue;
    const atx = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/);
    const setext =
      i + 1 < lines.length &&
      /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1] ?? "") &&
      line.trim() &&
      !/^ {4}/.test(line);
    if (atx || setext) {
      const base = slug(atx ? atx[1] : line.trim());
      let anchor = base;
      let count = counts.get(base) ?? 0;
      while (found.has(anchor)) {
        count += 1;
        anchor = `${base}-${count}`;
      }
      counts.set(base, count);
      found.add(anchor);
      if (setext) i += 1;
    }
    for (const match of line.matchAll(
      /<a\s+[^>]*?(?:id|name)=["']([^"']+)["'][^>]*>/g,
    )) {
      found.add(match[1]);
    }
  }
  return found;
}

// Читаем назначение с вложенными скобками и необязательной подписью ссылки.
function destination(text, start, closing) {
  let i = start;
  while (/\s/.test(text[i] ?? "") && i < text.length) i += 1;
  let target = "";
  if (text[i] === "<") {
    i += 1;
    while (i < text.length && text[i] !== ">") target += text[i++];
    if (text[i] !== ">") return undefined;
    i += 1;
  } else {
    let depth = 0;
    while (i < text.length) {
      const char = text[i];
      if (char === "\\" && i + 1 < text.length) {
        target += text[i + 1];
        i += 2;
        continue;
      }
      if (depth === 0 && (/\s/.test(char) || (closing && char === ")"))) break;
      if (char === "(") depth += 1;
      if (char === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      target += char;
      i += 1;
    }
  }
  while (/\s/.test(text[i] ?? "") && i < text.length) i += 1;
  let title = "";
  if (['"', "'", "("].includes(text[i])) {
    const end = text[i] === "(" ? ")" : text[i];
    i += 1;
    while (i < text.length && text[i] !== end) {
      if (text[i] === "\\" && i + 1 < text.length) i += 1;
      title += text[i++];
    }
    if (text[i] !== end) return undefined;
    i += 1;
    while (/\s/.test(text[i] ?? "") && i < text.length) i += 1;
  }
  if (closing && text[i] !== ")") return undefined;
  if (!closing && i !== text.length) return undefined;
  return { target, title, end: closing ? i + 1 : i };
}

function links(source) {
  let text = withoutCode(source);
  const references = new Map();
  const normalizeReference = (value) =>
    value.trim().replace(/\s+/g, " ").toLowerCase();
  text = text.replace(
    /^ {0,3}\[([^\]\n]+)\]:[ \t]*(.*)$/gm,
    (whole, label, rest) => {
      const parsed = destination(rest, 0, false);
      if (parsed && !references.has(normalizeReference(label))) {
        references.set(normalizeReference(label), parsed);
      }
      return blank(whole);
    },
  );
  const found = [];
  const add = (parsed, at, wiki = false) =>
    found.push({
      ...parsed,
      wiki,
      line: 1 + text.slice(0, at).split("\n").length - 1,
    });
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] !== "[") continue;
    if (text[i + 1] === "[") {
      const end = text.indexOf("]]", i + 2);
      if (end < 0) continue;
      const value = text.slice(i + 2, end);
      if (!value.includes("\n"))
        add({ target: value.split("|")[0].trim(), title: "" }, i, true);
      i = end + 1;
      continue;
    }
    let end = i + 1;
    let depth = 1;
    for (; end < text.length; end += 1) {
      if (text[end] === "\\") {
        end += 1;
        continue;
      }
      if (text[end] === "[") depth += 1;
      if (text[end] === "]" && --depth === 0) break;
      if (text[end] === "]" && depth < 0) break;
    }
    if (depth !== 0) continue;
    const label = text.slice(i + 1, end);
    let next = end + 1;
    if (text[next] === "(") {
      const parsed = destination(text, next + 1, true);
      if (parsed) {
        add(parsed, i);
        i = parsed.end - 1;
      }
      continue;
    }
    if (text[next] === "[") {
      const refEnd = text.indexOf("]", next + 1);
      if (refEnd >= 0) {
        const ref = text.slice(next + 1, refEnd) || label;
        const parsed = references.get(normalizeReference(ref));
        if (parsed) {
          add(parsed, i);
          i = refEnd;
        }
      }
      continue;
    }
    const parsed = references.get(normalizeReference(label));
    if (parsed) add(parsed, i);
    i = end;
  }
  return found;
}

function inspect(documents, lookup) {
  const errors = [];
  const warnings = [];
  const graph = new Map([...documents.keys()].map((name) => [name, new Set()]));
  const headingMap = new Map(
    [...documents].map(([name, text]) => [name, anchors(text)]),
  );
  let ordinaryCount = 0;
  let wikiCount = 0;
  let artifactCount = 0;
  const fail = (name, line, message) =>
    errors.push(`${name}:${line}: ${message}`);
  for (const [name, source] of documents) {
    source.split("\n").forEach((line, i) => {
      if (line.includes("\u2014"))
        fail(name, i + 1, "длинное тире; используйте дефис");
      if (/[\u0000\uFFFD]/.test(line))
        fail(name, i + 1, "поврежденный символ или нулевой байт");
    });
    for (const link of links(source)) {
      const { target, line, wiki } = link;
      const scheme = target.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
      if (scheme || target.startsWith("//")) {
        if (wiki) fail(name, line, "вики-ссылка должна вести в базу знаний");
        else if (
          scheme &&
          !["http", "https", "mailto", "tel"].includes(scheme)
        ) {
          fail(
            name,
            line,
            `непереносимая или неподдерживаемая схема адреса: ${target}`,
          );
        }
        continue;
      }
      if (wiki) wikiCount += 1;
      else ordinaryCount += 1;
      let route;
      let anchor;
      try {
        const hash = target.indexOf("#");
        route = decodeURIComponent(
          (hash < 0 ? target : target.slice(0, hash)).split("?")[0],
        );
        anchor =
          hash < 0 ? undefined : decodeURIComponent(target.slice(hash + 1));
      } catch {
        fail(name, line, `неверная кодировка адреса: ${target}`);
        continue;
      }
      if (
        route.startsWith("/") ||
        route.includes("\\") ||
        /^[a-z]:/i.test(route)
      ) {
        fail(name, line, `нужен переносимый относительный путь: ${target}`);
        continue;
      }
      let resolved =
        route === ""
          ? name
          : path.posix.normalize(
              path.posix.join(wiki ? "" : path.posix.dirname(name), route),
            );
      if (resolved === ".." || resolved.startsWith("../")) {
        fail(name, line, `ссылка выходит за корень: ${target}`);
        continue;
      }
      if (wiki && route !== "" && !resolved.endsWith(".md")) resolved += ".md";
      const artifact = localArtifacts.some((prefix) =>
        resolved.startsWith(prefix),
      );
      if (artifact) {
        if (wiki || link.title !== "local-only") {
          fail(
            name,
            line,
            `локальный артефакт требует обычной ссылки с подписью "local-only": ${target}`,
          );
        } else {
          artifactCount += 1;
          warnings.push(
            `${name}:${line}: локальный артефакт отсутствует в Git: ${resolved}`,
          );
        }
        continue;
      }
      if (
        resolved
          .split("/")
          .some(
            (part) =>
              excludedDirectoryNames.has(part) ||
              part === ".env" ||
              part.startsWith(".env."),
          )
      ) {
        fail(
          name,
          line,
          `цель исключена из переносимой базы знаний: ${target}`,
        );
        continue;
      }
      if (wiki && !documents.has(resolved)) {
        const candidates = [...documents.keys()].filter(
          (entry) =>
            path.posix.basename(entry) === path.posix.basename(resolved),
        );
        fail(
          name,
          line,
          candidates.length > 1
            ? `неоднозначная вики-ссылка; укажите путь от корня: ${target}`
            : `вики-ссылка требует полного пути к документу базы: ${target}`,
        );
        continue;
      }
      const result = lookup(resolved);
      if (result === "missing") {
        fail(name, line, `цель не существует: ${target}`);
        continue;
      }
      if (result === "case") {
        fail(name, line, `регистр пути не совпадает с именем файла: ${target}`);
        continue;
      }
      if (
        anchor &&
        (!headingMap.has(resolved) || !headingMap.get(resolved).has(anchor))
      ) {
        fail(name, line, `якорь не найден в Markdown-документе: ${target}`);
      }
      if (!wiki && documents.has(resolved)) graph.get(name).add(resolved);
    }
  }
  if (!documents.has("INDEX.md")) {
    errors.push("INDEX.md: отсутствует корневая карта проекта");
  } else {
    const visited = new Set();
    const pending = ["INDEX.md"];
    while (pending.length) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...graph.get(current));
    }
    for (const name of documents.keys()) {
      if (!visited.has(name))
        errors.push(
          `${name}: документ недостижим из INDEX.md по обычным ссылкам`,
        );
    }
  }
  return {
    errors,
    warnings,
    documents: documents.size,
    ordinaryCount,
    wikiCount,
    artifactCount,
  };
}

function collect(root) {
  const documents = new Map();
  function read(name) {
    documents.set(name, fs.readFileSync(path.join(root, name), "utf8"));
  }
  function walk(relative) {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) return;
    if (!fs.lstatSync(full).isDirectory()) return;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory() && !excludedDirectoryNames.has(entry.name))
        walk(name);
      else if (entry.isFile() && entry.name.endsWith(".md")) read(name);
    }
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) read(entry.name);
  }
  for (const directory of checkedDirectories) walk(directory);
  for (const name of extraDocuments) {
    const full = path.join(root, name);
    if (fs.existsSync(full) && fs.lstatSync(full).isFile()) read(name);
  }
  return new Map([...documents].sort(([a], [b]) => a.localeCompare(b)));
}

function filesystemLookup(root) {
  return (relative) => {
    let current = root;
    for (const part of relative.split("/")) {
      if (part === ".") continue;
      let entries;
      try {
        entries = fs.readdirSync(current);
      } catch {
        return "missing";
      }
      if (!entries.includes(part))
        return entries.some(
          (entry) => entry.toLowerCase() === part.toLowerCase(),
        )
          ? "case"
          : "missing";
      current = path.join(current, part);
      // Переход по ссылке Windows может вывести проверку за разрешенную область.
      if (fs.lstatSync(current).isSymbolicLink()) return "missing";
    }
    return fs.statSync(current).isDirectory() ? "directory" : "file";
  };
}

function selfTest() {
  const cases = [
    [
      "кириллица, кодировка, якорь и псевдоним",
      {
        "INDEX.md":
          "[Карта](knowledge/%D0%BA%D0%B0%D1%80%D1%82%D0%B0.md#раздел-1)\n[[knowledge/карта|Карта]]",
        "knowledge/карта.md": "# Раздел 1\n",
      },
      undefined,
    ],
    [
      "битая обычная ссылка",
      { "INDEX.md": "[Нет](missing.md)" },
      "цель не существует",
    ],
    [
      "неверный якорь",
      { "INDEX.md": "# Карта\n[Нет](#missing)" },
      "якорь не найден",
    ],
    [
      "выход за корень",
      { "INDEX.md": "[Нет](../outside.md)" },
      "ссылка выходит за корень",
    ],
    [
      "защищенный служебный каталог",
      { "INDEX.md": "[Нет](.git/config)" },
      "цель исключена",
    ],
    [
      "локальный адрес вне репозитория",
      { "INDEX.md": "[Нет](file:///C:/outside.md)" },
      "непереносимая",
    ],
    [
      "файл окружения исключен",
      { "INDEX.md": "[Нет](.env.local)" },
      "цель исключена",
    ],
    [
      "неоднозначная вики-ссылка",
      {
        "INDEX.md": "[А](knowledge/а.md) [Б](research/а.md)\n[[а|Цель]]",
        "knowledge/а.md": "# А",
        "research/а.md": "# Б",
      },
      "неоднозначная вики-ссылка",
    ],
    [
      "недостижимый документ",
      { "INDEX.md": "# Карта", "knowledge/hidden.md": "# Скрыто" },
      "недостижим",
    ],
    [
      "карта материалов проверок включена в граф",
      {
        "INDEX.md": "[Материалы](research-data/README.md)",
        "research-data/README.md": "# Материалы\n[Журнал](checks.json)",
      },
      undefined,
      ["research-data/checks.json"],
    ],
    [
      "битая ссылка карты материалов проверок",
      {
        "INDEX.md": "[Материалы](research-data/README.md)",
        "research-data/README.md": "# Материалы\n[Нет](missing.json)",
      },
      "цель не существует",
    ],
    [
      "вики-ссылка не заменяет обычную навигацию",
      {
        "INDEX.md": "[[knowledge/hidden|Скрыто]]",
        "knowledge/hidden.md": "# Скрыто",
      },
      "недостижим",
    ],
    [
      "ссылки в коде и комментариях пропускаются",
      {
        "INDEX.md":
          "# Карта\n`[Нет](missing.md)`\n```md\n[[missing]]\n```\n<!-- [Нет](missing.md) -->\n    [Нет](missing.md)",
      },
      undefined,
    ],
    [
      "повторяющиеся заголовки",
      { "INDEX.md": "# Один\n# Один\n[Да](#один-1)" },
      undefined,
    ],
    [
      "битая ссылка вложенного списка",
      { "INDEX.md": "- Раздел\n    - [Нет](missing.md)" },
      "цель не существует: missing.md",
    ],
    [
      "вложенный список участвует в достижимости",
      {
        "INDEX.md": "- Раздел\n    - [Карта](knowledge/map.md)",
        "knowledge/map.md": "# Карта",
      },
      undefined,
    ],
    [
      "огражденный код внутри цитаты исключен",
      { "INDEX.md": "> ```md\n> [Нет](missing.md)\n> ```" },
      undefined,
    ],
    [
      "заголовок огражденного кода цитаты не создает якорь",
      {
        "INDEX.md": "> ```md\n> # Ложный\n> ```\n[Нет](#ложный)",
      },
      "якорь не найден",
    ],
    [
      "огражденный код внутри списка исключен",
      { "INDEX.md": "- ```md\n  [Нет](missing.md)\n  ```" },
      undefined,
    ],
    [
      "блок кода с отступом внутри списка исключен",
      { "INDEX.md": "- Раздел\n\n      [Нет](missing.md)" },
      undefined,
    ],
    [
      "отступ продолжения абзаца не скрывает ссылку",
      { "INDEX.md": "Абзац\n    [Нет](missing.md)" },
      "цель не существует: missing.md",
    ],
    [
      "ссылка с вложенными скобками",
      { "INDEX.md": "[Да](asset(1).txt)" },
      undefined,
      ["asset(1).txt"],
    ],
    [
      "путь с пробелом",
      { "INDEX.md": "[Да](<имя файла.txt>)" },
      undefined,
      ["имя файла.txt"],
    ],
    [
      "ссылки через определение",
      { "INDEX.md": "[Да][карта]\n[карта]: #карта\n# Карта" },
      undefined,
    ],
    ["регистр пути", { "INDEX.md": "[Нет](index.md)" }, "регистр пути"],
    [
      "явный локальный артефакт",
      { "INDEX.md": '[Файл](research-data/apps/demo.exe "local-only")' },
      undefined,
    ],
    [
      "непомеченный локальный артефакт",
      { "INDEX.md": "[Файл](research-data/apps/demo.exe)" },
      "локальный артефакт требует",
    ],
    [
      "поврежденный символ",
      { "INDEX.md": "# Карта\n\uFFFD" },
      "поврежденный символ",
    ],
    ["длинное тире", { "INDEX.md": "# Карта\n\u2014" }, "длинное тире"],
  ];
  let failures = 0;
  for (const [name, entries, expected, assets = []] of cases) {
    const docs = new Map(Object.entries(entries));
    const paths = [...docs.keys(), ...assets];
    const result = inspect(docs, (target) =>
      paths.includes(target)
        ? "file"
        : paths.some((entry) => entry.toLowerCase() === target.toLowerCase())
          ? "case"
          : "missing",
    );
    const passed = expected
      ? result.errors.some((error) => error.includes(expected))
      : result.errors.length === 0;
    if (!passed) {
      failures += 1;
      console.error(`ОШИБКА: ${name}\n${result.errors.join("\n")}`);
    }
  }
  console.log(
    `Самопроверка: ${cases.length - failures}/${cases.length} сценариев пройдено.`,
  );
  return failures === 0;
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--self-test") {
  if (!selfTest()) process.exitCode = 1;
} else if (args.length) {
  console.error(
    "Использование: node scripts/check-knowledge.mjs [--self-test]",
  );
  process.exitCode = 2;
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = inspect(collect(root), filesystemLookup(root));
  for (const warning of result.warnings)
    console.warn(`ПРЕДУПРЕЖДЕНИЕ: ${warning}`);
  for (const error of result.errors) console.error(`ОШИБКА: ${error}`);
  console.log(
    `Документы: ${result.documents}; локальные Markdown-ссылки: ${result.ordinaryCount}; вики-ссылки: ${result.wikiCount}; локальные артефакты: ${result.artifactCount}; ошибки: ${result.errors.length}.`,
  );
  if (result.errors.length) process.exitCode = 1;
}

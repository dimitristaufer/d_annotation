import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename as moveFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export function normalizeAnnotatorName(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en")
    : "";
}

export function cleanAnnotatorName(value) {
  if (typeof value !== "string") return null;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return null;
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > 48) return null;
  return name;
}

function readRosterFile(file) {
  return readFile(file, "utf8").then((value) => {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return { profiles: {}, retired: [] };
    return {
      profiles: parsed.profiles && typeof parsed.profiles === "object" && !Array.isArray(parsed.profiles) ? parsed.profiles : {},
      retired: Array.isArray(parsed.retired) ? parsed.retired.filter((name) => typeof name === "string") : [],
    };
  }).catch((error) => {
    if (error?.code === "ENOENT") return { profiles: {}, retired: [] };
    throw error;
  });
}

export function createAnnotatorRosterStore(dataDirectory) {
  const directory = path.resolve(dataDirectory);
  const rosterPath = path.join(directory, "annotator-profiles.json");
  const lockPath = path.join(directory, "annotator-profiles.lock");
  let cachedNames = null;
  let cacheExpiresAt = 0;
  let cachedVersion = "";

  async function withLock(operation) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let lock;
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try { lock = await open(lockPath, "wx", 0o600); break; }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try { if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) await unlink(lockPath); } catch { /* another writer released the lock */ }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (!lock) throw new Error("Could not lock shared annotator profiles.");
    try { return await operation(); }
    finally { await lock.close(); await unlink(lockPath).catch(() => undefined); }
  }

  async function writeRoster(roster) {
    const temporary = `${rosterPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, profiles: roster.profiles, retired: roster.retired }), { mode: 0o600 });
    await moveFile(temporary, rosterPath);
  }

  async function discoverAnnotationNames() {
    const annotationsDirectory = path.join(directory, "shared-annotations");
    let files;
    try { files = (await readdir(annotationsDirectory)).filter((file) => file.endsWith(".json")); }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    const names = new Set();
    for (let offset = 0; offset < files.length; offset += 100) {
      const records = await Promise.all(files.slice(offset, offset + 100).map(async (file) => {
        try { return JSON.parse(await readFile(path.join(annotationsDirectory, file), "utf8")); }
        catch (error) { if (error?.code === "ENOENT") return null; throw error; }
      }));
      for (const record of records) {
        for (const name of Object.keys(record?.humans ?? {})) {
          const clean = cleanAnnotatorName(name);
          if (clean) names.add(clean);
        }
      }
    }
    return [...names];
  }

  async function version() {
    const values = await Promise.all([rosterPath, path.join(directory, "shared-annotations")].map(async (file) => {
      try { const details = await stat(file); return `${details.mtimeMs}:${details.size}`; }
      catch (error) { if (error?.code === "ENOENT") return "missing"; throw error; }
    }));
    return values.join("|");
  }

  async function list() {
    const currentVersion = await version();
    if (cachedNames && cacheExpiresAt > Date.now() && cachedVersion === currentVersion) return [...cachedNames];
    const roster = await readRosterFile(rosterPath);
    const retired = new Set(roster.retired.map(normalizeAnnotatorName));
    const namesByKey = new Map();
    for (const [key, entry] of Object.entries(roster.profiles)) {
      const name = cleanAnnotatorName(typeof entry === "string" ? entry : entry?.name);
      if (name && !retired.has(normalizeAnnotatorName(name))) namesByKey.set(normalizeAnnotatorName(name), name);
    }
    for (const name of await discoverAnnotationNames()) {
      const key = normalizeAnnotatorName(name);
      if (!retired.has(key) && !namesByKey.has(key)) namesByKey.set(key, name);
    }
    cachedNames = [...namesByKey.values()].sort((left, right) => left.localeCompare(right));
    cacheExpiresAt = Date.now() + 15_000;
    cachedVersion = await version();
    return [...cachedNames];
  }

  async function register(values) {
    const names = [...new Set(values.map(cleanAnnotatorName).filter(Boolean))];
    return withLock(async () => {
      const roster = await readRosterFile(rosterPath);
      const retired = new Set(roster.retired.map(normalizeAnnotatorName));
      for (const name of names) {
        const key = normalizeAnnotatorName(name);
        if (!roster.profiles[key]) roster.profiles[key] = { name, createdAt: new Date().toISOString() };
        retired.delete(key);
      }
      roster.retired = [...retired];
      await writeRoster(roster);
      cachedNames = null;
      cachedVersion = "";
      return names.length;
    });
  }

  async function rename(oldValue, newValue) {
    const oldName = cleanAnnotatorName(oldValue);
    const newName = cleanAnnotatorName(newValue);
    if (!oldName || !newName) throw new TypeError("Provide valid current and new annotator names.");
    return withLock(async () => {
      const roster = await readRosterFile(rosterPath);
      const oldKey = normalizeAnnotatorName(oldName);
      const newKey = normalizeAnnotatorName(newName);
      if (oldKey !== newKey && roster.profiles[newKey]) throw new Error("An annotator with that name already exists.");
      const previous = roster.profiles[oldKey];
      if (oldKey !== newKey) {
        delete roster.profiles[oldKey];
        roster.retired = [...new Set([...roster.retired.map(normalizeAnnotatorName), oldKey])];
      }
      roster.profiles[newKey] = { name: newName, createdAt: previous?.createdAt ?? new Date().toISOString() };
      roster.retired = roster.retired.filter((name) => normalizeAnnotatorName(name) !== newKey);
      await writeRoster(roster);
      cachedNames = null;
      cachedVersion = "";
    });
  }

  async function remove(value) {
    const name = cleanAnnotatorName(value);
    if (!name) throw new TypeError("Provide a valid annotator name.");
    return withLock(async () => {
      const roster = await readRosterFile(rosterPath);
      const key = normalizeAnnotatorName(name);
      delete roster.profiles[key];
      roster.retired = [...new Set([...roster.retired.map(normalizeAnnotatorName), key])];
      await writeRoster(roster);
      cachedNames = null;
      cachedVersion = "";
    });
  }

  return { list, register, rename, remove };
}

import fs from 'node:fs';
import path from 'node:path';

/**
 * Armazenamento em disco (desenvolvimento local).
 * - spec atual:   <specsDir>/<apiId>.json  (lida pelo specs.js, que recarrega pelo mtime)
 * - anterior:     <specsDir>/.historico/<apiId>-<data>.json
 * - registro:     <specsDir>/.historico/<apiId>.meta.json (última mudança)
 */
export function createFsStore({ specsDir }) {
  const historyDir = path.join(specsDir, '.historico');
  const specFile = (apiId) => path.join(specsDir, `${apiId}.json`);
  const metaFile = (apiId) => path.join(historyDir, `${apiId}.meta.json`);

  const atomicWrite = (file, text) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  };

  return {
    tipo: 'disco',
    descricao: `pasta ${specsDir}`,

    async readMeta(apiId) {
      try {
        return JSON.parse(fs.readFileSync(metaFile(apiId), 'utf8'));
      } catch {
        return {};
      }
    },

    async writeMeta(apiId, meta) {
      fs.mkdirSync(historyDir, { recursive: true });
      fs.writeFileSync(metaFile(apiId), `${JSON.stringify(meta, null, 2)}\n`);
    },

    async readCurrent(apiId) {
      try {
        const file = specFile(apiId);
        return { text: fs.readFileSync(file, 'utf8'), salvoEm: fs.statSync(file).mtime.toISOString() };
      } catch {
        return null;
      }
    },

    /** Grava a versão nova; a anterior vira backup. Retorna o nome do backup. */
    async saveVersion(apiId, text, { stamp }) {
      fs.mkdirSync(historyDir, { recursive: true });
      let backup = null;
      const file = specFile(apiId);
      if (fs.existsSync(file)) {
        backup = `${apiId}-${stamp}.json`;
        fs.copyFileSync(file, path.join(historyDir, backup));
      }
      atomicWrite(file, text);
      return { backup, versao: null };
    },

    async listBackups(apiId) {
      let files;
      try {
        files = fs.readdirSync(historyDir);
      } catch {
        return [];
      }
      const re = new RegExp(`^${apiId.replace(/[.]/g, '\\.')}-\\d{8}-\\d{6}(?:-\\d{3})?\\.json$`);
      return files
        .filter((f) => re.test(f))
        .sort()
        .reverse()
        .map((arquivo) => {
          const stat = fs.statSync(path.join(historyDir, arquivo));
          return { arquivo, tamanho: stat.size, salvoEm: stat.mtime.toISOString() };
        });
    },

    async readBackup(apiId, arquivo) {
      if (!(await this.listBackups(apiId)).some((b) => b.arquivo === arquivo)) return null;
      return fs.readFileSync(path.join(historyDir, arquivo), 'utf8');
    },

    async deleteBackup(apiId, arquivo) {
      try {
        fs.unlinkSync(path.join(historyDir, arquivo));
      } catch {
        /* ignora */
      }
    },
  };
}

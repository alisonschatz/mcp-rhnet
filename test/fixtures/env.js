// Importado primeiro pelos testes: aponta as specs para as de teste (o projeto não tem spec fixa).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SPECS_DIR ||= path.join(path.dirname(fileURLToPath(import.meta.url)), 'specs');

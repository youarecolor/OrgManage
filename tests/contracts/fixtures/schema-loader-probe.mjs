import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const mode = process.argv[2];
if (!['clean', 'tampered'].includes(mode)) throw new Error('Expected clean or tampered probe mode');
const originalRead = fs.readFileSync;
let tampered = false;
if (mode === 'tampered') {
  // Alter only the loader return value in this isolated test process. No source file is edited.
  fs.readFileSync = function (path, ...options) {
    const result = originalRead.call(this, path, ...options);
    if (String(path).replaceAll('\\', '/').endsWith('/packages/contracts/schema/command.schema.json')) {
      const schema = JSON.parse(typeof result === 'string' ? result : result.toString('utf8'));
      schema.oneOf[0].properties.protocol_version.const = 2;
      const replacement = JSON.stringify(schema);
      tampered = true;
      return typeof result === 'string' ? replacement : Buffer.from(replacement, 'utf8');
    }
    return result;
  };
  syncBuiltinESMExports();
}
try {
  await import('../../../dist/contracts/src/index.js');
  process.stdout.write(JSON.stringify({ loaded: true, tampered }));
} catch (error) {
  process.stdout.write(JSON.stringify({ loaded: false, tampered, error: String(error) }));
}

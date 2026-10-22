import fs from 'node:fs';
import { pool } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { importProductCsv } from './listimport.js';
import { syncList, syncDetails } from './chronokey/sync.js';
import { syncVault } from './vault/sync.js';
import { runJob } from './jobs.js';
import { tidyDuplicatePhotos } from '../watches/index.js';

/*
 * npm run import -- csv <file>        Chrono Key's product list, exported as CSV
 * npm run import -- list              the product list, live from Chrono Key
 * npm run import -- details [new|active|full] [limit]
 *                                     each watch's page and photos
 * npm run import -- vault             the Watch vault
 * npm run import -- all               list, new details, vault
 * npm run import -- tidy-photos       hide repeats among photos already copied
 */
const [cmd, ...args] = process.argv.slice(2);
const show = (s) => console.log(JSON.stringify(s, null, 2));

try {
  await migrate({ log: () => {} });
  await runJob(`cli ${cmd}`, async () => {
    if (cmd === 'csv') show(await importProductCsv(fs.readFileSync(args[0], 'utf8')));
    else if (cmd === 'list') show(await syncList());
    else if (cmd === 'details') {
      show(
        await syncDetails({
          mode: args[0] || 'new',
          limit: Number(args[1]) || Infinity,
          onProgress: (s) => console.log(`  ${s.done}/${s.todo} pages, ${s.photos} photos, ${s.failed} failed`),
        })
      );
    } else if (cmd === 'vault') show(await syncVault());
    else if (cmd === 'all') {
      show(await syncList());
      show(await syncDetails({ mode: 'new' }));
      show(await syncVault());
    } else if (cmd === 'tidy-photos') show(await tidyDuplicatePhotos());
    else console.log('usage: npm run import -- csv <file> | list | details [new|active|full] [limit] | vault | all | tidy-photos');
  });
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

#!/usr/bin/env node
'use strict';
/**
 * رديف — Radeef Tenant Manager CLI (same validation + operations as the web panel).
 *
 *   node cli.js list
 *   node cli.js create <name> <domain> --email <client_email> [--admin-email <email>] [--months N] [--template <release_dir>]
 *   node cli.js start|stop|restart <name>
 *   node cli.js delete <name>                 (asks you to type the name; backs up first)
 *   node cli.js adopt <name> <domain> [--email <client_email>] [--end-date YYYY-MM-DD]
 *   node cli.js renew <name> <months>
 *   node cli.js backup
 *   node cli.js check-licenses
 *   node cli.js employees                     (read-only active-employee count per tenant)
 *   node cli.js commercial <name> [--price N] [--currency SAR] [--cycle annual] [--paid-until YYYY-MM-DD]
 *                                 [--vat-rate N] [--includes-vat true|false]   (omitted = cleared)
 *   node cli.js notices                       (last license e-mails and their outcome)
 *
 * Connection settings come from the environment / radeef-manage/.env (see .env.example):
 * SSH_HOST, SSH_USER, SSH_KEY_PATH (or SSH_PASSWORD), SSH_HOST_FINGERPRINT, PGHOST/PGUSER/PGPASSWORD…
 * No credentials are stored in this file.
 */
const readline = require('readline');
const { loadConfig, loadSshConfig } = require('./lib/config');
const ssh = require('./lib/ssh');
const ops = require('./lib/ops');
const V = require('./lib/validate');
const { openStore } = require('./lib/store');

const c = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

function ask(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    }),
  );
}

function flag(args, name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : undefined;
}

function printHelp() {
  console.log(`
${c.bright}رديف — Radeef Tenant Manager CLI${c.reset}

  ${c.green}node cli.js list${c.reset}                              عرض النسخ (المسجلة وغير المسجلة)
  ${c.green}node cli.js create <name> <domain> --email <client_email> [--admin-email <e>] [--months N] [--template <dir>]${c.reset}
      إنشاء نسخة من مجلد إصدار نظيف (RELEASE_DIRS)، قاعدة بيانات ودور مستقلان، migrate + seed، PM2 و Nginx.
      كلمة مرور المدير الأولية تُطبع مرة واحدة فقط.
  ${c.green}node cli.js start|stop|restart <name>${c.reset}           التحكم بعملية PM2
  ${c.green}node cli.js delete <name>${c.reset}                     حذف نهائي بعد نسخة احتياطية إلزامية (يطلب كتابة الاسم)
  ${c.green}node cli.js adopt <name> <domain> [--email e] [--end-date YYYY-MM-DD]${c.reset}  تسجيل نسخة قائمة
  ${c.green}node cli.js renew <name> <months>${c.reset}             تجديد الترخيص
  ${c.green}node cli.js backup${c.reset}                            نسخة احتياطية لكل قواعد البيانات الآن
  ${c.green}node cli.js check-licenses${c.reset}                    تشغيل فحص التراخيص الآن (إيقاف بعد تاريخ الانتهاء فقط، وتذكير يومي واحد خلال آخر 14 يوماً)
  ${c.green}node cli.js employees${c.reset}                         عدد الموظفين النشطين لكل نسخة (قراءة فقط)
  ${c.green}node cli.js commercial <name> [--price N] [--currency SAR] [--cycle annual] [--paid-until YYYY-MM-DD] [--vat-rate N] [--includes-vat true|false]${c.reset}
      الحقول التجارية الاختيارية (ما لم يُمرَّر يُفرَّغ)
  ${c.green}node cli.js notices${c.reset}                           آخر رسائل الترخيص ونتيجتها
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = (args[0] || '').toLowerCase();
  if (!command || command === 'help' || command === '--help') {
    printHelp();
    return;
  }

  const cfg = loadConfig();
  const sshOptions = loadSshConfig();
  const store = openStore();
  const getConn = () => ssh.connect(sshOptions);
  const log = (msg, type) => {
    const color = type === 'error' ? c.red : type === 'success' ? c.green : type === 'warning' ? c.yellow : '';
    console.log(`${color}${msg}${c.reset}`);
  };

  try {
    switch (command) {
      case 'list': {
        const tenants = await ssh.withConnection(sshOptions, (conn) => ops.listTenants(conn, store, cfg));
        console.log(`\n${c.cyan}${c.bright}=== النسخ على السيرفر ===${c.reset}\n`);
        console.log(`${c.bright}${'NAME'.padEnd(18)} ${'PORT'.padEnd(6)} ${'PM2'.padEnd(10)} ${'LICENSE'.padEnd(13)} ${'END'.padEnd(11)} DOMAIN${c.reset}`);
        for (const t of tenants) {
          const pm2Color = t.status === 'online' ? c.green : c.red;
          console.log(
            `${t.name.padEnd(18)} ${String(t.port).padEnd(6)} ${pm2Color}${String(t.status).padEnd(10)}${c.reset} ${t.license_status.padEnd(13)} ${String(t.end_date || '-').padEnd(11)} ${t.domain}`,
          );
        }
        console.log();
        break;
      }
      case 'create': {
        const [name, domain] = [args[1], args[2]];
        const clientEmail = flag(args, '--email') || cfg.defaultClientEmail;
        if (!name || !domain || !clientEmail) {
          console.error(`${c.red}الاستخدام: node cli.js create <name> <domain> --email <client_email>${c.reset}`);
          process.exitCode = 1;
          break;
        }
        const params = {
          name,
          domain,
          client_email: clientEmail,
          admin_email: flag(args, '--admin-email') || clientEmail,
          duration_months: flag(args, '--months') || 1,
          template: flag(args, '--template'),
        };
        const result = await ops.serialize(() => ssh.withConnection(sshOptions, (conn) => ops.createTenant(conn, store, cfg, params, log)));
        console.log(`\n${c.green}${c.bright}تم إنشاء النسخة بنجاح${c.reset}`);
        console.log(`الرابط:        ${c.bright}${result.credentials.url}${c.reset}`);
        console.log(`بريد المدير:   ${c.bright}${result.credentials.email}${c.reset}`);
        console.log(`كلمة المرور:   ${c.bright}${result.credentials.password}${c.reset}`);
        console.log(`${c.yellow}تُعرض كلمة المرور هذه مرة واحدة فقط — سلّمها للعميل بقناة آمنة واطلب تغييرها.${c.reset}\n`);
        break;
      }
      case 'start':
      case 'stop':
      case 'restart': {
        const name = V.validateExistingName(args[1]);
        await ssh.withConnection(sshOptions, (conn) => ops.pm2Action(conn, store, command, name));
        log('تم تنفيذ الأمر بنجاح.', 'success');
        break;
      }
      case 'delete': {
        const name = V.validateExistingName(args[1]);
        console.log(`${c.red}${c.bright}تحذير: سيتم حذف النسخة ${name} نهائياً (بعد أخذ نسخة احتياطية من قاعدة البيانات والملفات).${c.reset}`);
        const confirm = await ask(`${c.yellow}اكتب اسم النسخة للتأكيد (${name}): ${c.reset}`);
        if (confirm.trim() !== name) {
          log('تأكيد خاطئ. تم الإلغاء.', 'error');
          process.exitCode = 1;
          break;
        }
        const result = await ops.serialize(() =>
          ssh.withConnection(sshOptions, (conn) => ops.deleteTenant(conn, store, cfg, { name, confirm: confirm.trim() }, log)),
        );
        log(`تم الحذف. النسخ الاحتياطية في ${result.backupDir}`, 'success');
        break;
      }
      case 'adopt': {
        const result = await ssh.withConnection(sshOptions, (conn) =>
          ops.adoptTenant(conn, store, { name: args[1], domain: args[2], client_email: flag(args, '--email'), end_date: flag(args, '--end-date') }),
        );
        log(`تم تسجيل ${result.name} (${result.domain})${result.end_date ? ` حتى ${result.end_date}` : ' بدون انتهاء تلقائي'}.`, 'success');
        break;
      }
      case 'renew': {
        const result = await ops.renewTenant(getConn, store, cfg, { name: args[1], duration_months: args[2] });
        log(`تم التجديد: ${result.start_date} → ${result.end_date}`, 'success');
        break;
      }
      case 'backup': {
        const result = await ssh.withConnection(sshOptions, (conn) => ops.backupAll(conn, store, cfg, (m) => console.log(m)));
        log(`اكتمل: ${result.ok.length} ناجحة، ${result.failed.length} فاشلة (${result.dir})`, result.failed.length ? 'error' : 'success');
        if (result.failed.length) process.exitCode = 1;
        break;
      }
      case 'check-licenses': {
        const { sendAlertEmail } = require('./lib/mailer');
        const results = await ops.checkLicenses(getConn, store, cfg, { notify: sendAlertEmail });
        log(`اكتمل فحص التراخيص (${results.length} إجراء).`, 'success');
        break;
      }
      case 'employees': {
        const counts = await ssh.withConnection(sshOptions, (conn) => ops.employeeCounts(conn, store, cfg));
        for (const [name, r] of Object.entries(counts)) {
          console.log(`${name.padEnd(18)} ${r.active === null ? `${c.red}-${c.reset} (${r.error})` : r.active}`);
        }
        break;
      }
      case 'commercial': {
        const result = await ops.setCommercial(store, {
          name: args[1],
          price: flag(args, '--price'),
          currency: flag(args, '--currency'),
          billing_cycle: flag(args, '--cycle'),
          paid_until: flag(args, '--paid-until'),
          vat_rate: flag(args, '--vat-rate'),
          price_includes_vat: flag(args, '--includes-vat'),
        });
        log(`تم الحفظ: ${JSON.stringify(result)}`, 'success');
        break;
      }
      case 'notices': {
        for (const n of await store.lastNotices(50)) {
          console.log(`${n.day}  ${String(n.name).padEnd(18)} ${String(n.kind).padEnd(8)} ${String(n.days_remaining ?? '').padStart(3)}  ${n.outcome}`);
        }
        break;
      }
      default:
        console.log(`${c.red}أمر غير معروف: ${command}${c.reset}`);
        printHelp();
        process.exitCode = 1;
    }
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(`\n${c.red}خطأ: ${err.message}${c.reset}`);
  if (err.stderrTail) console.error(err.stderrTail);
  process.exitCode = 1;
});

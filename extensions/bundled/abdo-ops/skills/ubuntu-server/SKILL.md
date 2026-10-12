---
name: ubuntu-server
description: إدارةُ خادم أوبونتو بأمان — قياسُ الحالة قبل أيّ تغيير، apt، المستخدمون ومفاتيح SSH، الجدار ufw وfail2ban، وحدات systemd، السجلّات، والنسخُ الاحتياطيّ قبل اللمس. استعملها حين تعمل على خادمٍ عبر server run أو تجهّز خادماً جديداً.
---

# خادم أوبونتو — قِس، انسخ، غيّر، تحقّق

كلُّ أمرٍ على الخادم يمرّ بـ`server run <اسم> -- <أمر>` (يُعرض للموافقة). لا تفترض شيئاً عن الخادم: اقرأه.

## 1. القياسُ أوّلاً (أمرٌ واحد، قراءةٌ فقط)

```
server run <اسم> -- "lsb_release -ds; uname -m; nproc; free -h | sed -n 2p; df -h / | tail -1; uptime -p; systemctl --failed --no-legend | head"
```

- الإصدار: `24.04` أو `22.04` — لا تُصدر أوامرَ إصدارٍ آخر.
- القرص فوق 85% ⇦ قل ذلك قبل أيّ تثبيت؛ لا تحذف لتفسح مكاناً بلا موافقة وسردٍ للمحذوف.
- وحداتٌ فاشلة ⇦ اذكرها؛ قد تكون سببَ ما طُلب منك.

## 2. ما الذي يعمل فعلاً؟ (الحيُّ من العمليّة لا من الإعداد)

```
server run <اسم> -- "ss -ltnp | head -30; systemctl list-units --type=service --state=running --no-legend | head -40"
```

إن كان المنفذُ مشغولاً فمالكُه هو الحقيقة — لا اسمُ الملفّ ولا ما كتبه أحدٌ في README. مع pm2: `pm2 jlist` ثمّ `pm_cwd` لكلّ عمليّة.

## 3. الحزم

- `sudo apt-get update` ثمّ `sudo apt-get install -y --no-install-recommends <حزم>` — بأسماءٍ صريحة، لا `apt upgrade` شاملٌ على خادمٍ حيّ بلا موافقة.
- بعد التثبيت: أثبت بالإصدار (`<أداة> --version`) لا بنجاح apt.

## 4. المستخدمون وSSH

- خدمةٌ = مستخدمٌ بلا صلاحيات: `sudo adduser --system --group --home /srv/<تطبيق> <تطبيق>`.
- SSH بالمفاتيح وحدها. قبل تعديل `/etc/ssh/sshd_config`: انسخه، و`sudo sshd -t` قبل إعادة التحميل، **وابقِ جلستك مفتوحة** حتى تتحقّق من دخولٍ جديد — قفلُ نفسك خارج الخادم لا رجعةَ فيه.
- لا تطبع مفتاحاً خاصّاً ولا كلمةَ مرور؛ المفاتيحُ في الخزنة (`server add` يولّدها).

## 5. الجدار

- `sudo ufw status verbose` أوّلاً. قبل `ufw enable`: `sudo ufw allow OpenSSH` — وإلا انقطع الاتصال.
- افتح منفذَ التطبيق خلف nginx فقط (80/443)، لا منفذ Node مباشرةً.
- fail2ban: `sudo fail2ban-client status sshd`. **لا تفحص منفذ 22 باتّصالاتٍ خام متكرّرة** — تُحسب محاولاتٍ فاشلة وتحظر عنوانك.

## 6. systemd (أو pm2)

وحدةُ خدمة مثال — بمستخدمٍ غير root، و`Restart=on-failure`، و`WorkingDirectory` يشير إلى `current`:

```
[Unit]
Description=<تطبيق>
After=network.target
[Service]
User=<تطبيق>
WorkingDirectory=/srv/<تطبيق>/current
EnvironmentFile=/srv/<تطبيق>/current/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
[Install]
WantedBy=multi-user.target
```

ثمّ `sudo systemctl daemon-reload && sudo systemctl enable --now <تطبيق>` و`systemctl is-active <تطبيق>` و`journalctl -u <تطبيق> -n 50 --no-pager`.

## 7. قبل أيّ تغييرٍ هدّام

- نسخةٌ احتياطيّة مؤكَّدة (`cp -a x x.bak-$(date +%F)` أو `pg_dump … && echo OK` مع `|| exit` قبل الهجرة — هجرةٌ بعد نسخةٍ فشلت تجري وتُتلف).
- الحذفُ وإعادةُ التشغيل والهجرات على **الإنتاج** تحتاج موافقةَ المستخدم الصريحة في المحادثة.
- بعد التغيير: فحصُ صحّة (`curl -fsS http://127.0.0.1:<منفذ>/api/health`) وسطرٌ يقول ما تغيّر وكيف يُرجَع عنه.

# عبدو كود — الخزنة المشحونة مع المنتج (DPAPI لكل مستخدم).
#
# تتكلّم **العقد نفسه** الذي يقرؤه عامل Rust اليوم بلا أيّ تغيير فيه:
#   get  <handle>  → يطبع القيمة على stdout ويخرج بـ0 (غائب ⇒ خروجٌ غير صفريّ)
#   has  <handle>  → خروجٌ 0 إن كان المقبض موجوداً، وغير صفريّ إن لم يكن
# ويزيد فعلين للمحرّك وحده (عامل Rust لا يستدعيهما أبداً):
#   set  <handle>  → يقرأ القيمة من **stdin** لا من سطر الأمر، ويخزّنها
#   forget <handle>، list، guard
# و`guard` تُنشئ جذر الخزنة وتقصر صلاحياته على المستخدم وحده (بالوراثة)،
# فيُكتب ملفُّ القالب المؤقّت داخله محميّاً بالوراثة نفسها — لا يأخذ مساراً
# ولا يقبل وسيطاً، فلا يُوجَّه إلى مجلّدٍ آخر.
#
# لماذا stdin: سطرُ أمرِ أيّ عمليّة مقروءٌ لكلّ عمليّةٍ على الجهاز
# (Get-CimInstance Win32_Process). قيمةٌ تُمرَّر وسيطاً تُسرَّب لحظة تمريرها.
# ولهذا يرفض هذا السكربت أيّ وسيطٍ زائد بدل تجاهله: تمريرُ القيمة وسيطاً
# يجب أن **يفشل**، لا أن يعمل بصمت.
#
# لماذا البادئة 'v=' في الطباعة: قارئ Rust يُسقط كلّ شيءٍ حتى أوّل '='
# (ليقبل `KEY=value` و`value` معاً). البادئة تجعل أوّل '=' هو فاصلَنا نحن،
# فتنجو القيمُ التي تحوي '=' (base64) كما هي بدل أن تُبتر.
#
# DPAPI لكل مستخدم وجهاز: ملفّ خزنةٍ منسوخ إلى جهازٍ آخر لا يُفكّ — وهذا
# صحيح، ويُقال في نصّ الرفض كي لا يظنّ أحد أن السرّ ضاع.

[CmdletBinding()]
param(
  [Parameter(Position = 0)][string] $Verb,
  [Parameter(Position = 1)][string] $Handle,
  [Parameter(ValueFromRemainingArguments = $true)][string[]] $Extra
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

# 9 = وسيطٌ زائد. القيمة لا تُمرَّر في سطر الأمر أبداً.
if ($null -ne $Extra -and $Extra.Count -gt 0) { exit 9 }

$verbs = @('get', 'has', 'set', 'forget', 'list', 'guard')
if ([string]::IsNullOrEmpty($Verb) -or ($verbs -notcontains $Verb)) { exit 2 }

# جذرُ الخزنة تحت ملفّ المستخدم وحده — لا داخل المستودع ولا في مجلّد مشترك.
$root = $env:ABDO_VAULT_DIR
if ([string]::IsNullOrEmpty($root)) {
  if ([string]::IsNullOrEmpty($env:APPDATA)) { exit 8 }
  $root = Join-Path $env:APPDATA 'abdocode\vault'
}

if ($Verb -ne 'list' -and $Verb -ne 'guard') {
  # النمط نفسه الذي يفرضه المحرّك — وحسّاسٌ لحالة الأحرف قصداً.
  if ([string]::IsNullOrEmpty($Handle) -or ($Handle -cnotmatch '^[a-z0-9][a-z0-9-]{0,120}$')) { exit 3 }
}

$file = if ($Verb -eq 'list' -or $Verb -eq 'guard') { $null } else { Join-Path $root ($Handle + '.sec') }

# صلاحيات المستخدم وحده على جذر الخزنة، بالوراثة — فكلُّ ملفٍّ يُكتب فيه
# (ملفّ `.sec` وقالبُ الإدخال المؤقّت) يرث القصر نفسه بلا خطوةٍ ثانية.
#
# قياسٌ مدفوع (2026-09-02): البناءُ الأوّل كان يصنع `DirectorySecurity` جديداً
# ويضع المالك ثم `Set-Acl` — فيحاول Set-Acl كتابةَ قسم التدقيق (SACL) الذي
# يلزمه امتياز SeSecurityPrivilege، فيسقط النداءُ **الثاني** بـ
# PrivilegeNotHeld: أوّلُ تخزينٍ بعد `guard` كان يفشل دائماً. العلاج: نقرأ
# الواصف القائم بـ`Get-Acl` (لا يجلب SACL أصلاً)، ولا نلمس المالك (المُنشئ
# مالكٌ سلفاً)، ونخرج بلا عملٍ إن كان الجذر محميّاً — فالفعل متساوي القوى.
function Protect-Directory([string] $path) {
  if (-not (Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
  # نستخدم واجهة .NET مباشرةً بدل Get-Acl/Set-Acl. بعض بيئات التشغيل تضيف
  # أكثر من مسارٍ لوحدة Microsoft.PowerShell.Security؛ عندها يفشل التحميل
  # التلقائيّ بسبب TypeData مكرّر قبل أن يصل الأمر إلى القرص أصلاً.
  $directory = [System.IO.DirectoryInfo]::new($path)
  $acl = $directory.GetAccessControl()
  if ($acl.AreAccessRulesProtected) { return }
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void] $acl.RemoveAccessRule($rule) }
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
      $me, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
  $directory.SetAccessControl($acl)
}

switch ($Verb) {

  'has' {
    if (Test-Path -LiteralPath $file) { exit 0 } else { exit 1 }
  }

  'get' {
    if (-not (Test-Path -LiteralPath $file)) { exit 1 }
    $plain = $null
    $ptr = [IntPtr]::Zero
    $protectedBytes = $null
    $plainBytes = $null
    try {
      $armoured = [System.IO.File]::ReadAllText($file)
      if ($armoured.StartsWith('dpapi-v1:')) {
        $protectedBytes = [Convert]::FromBase64String($armoured.Substring(9))
        $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
          $protectedBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        $plain = [System.Text.Encoding]::UTF8.GetString($plainBytes)
      }
      else {
        # ملفات الإصدارات السابقة تبقى قابلة للقراءة ثم تُستبدل عند الحفظ.
        $secure = ConvertTo-SecureString -String $armoured
        $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
      }
    }
    catch {
      # 4 = تعذّر الفكّ: الملفّ لهذا المستخدم على هذا الجهاز وحده.
      exit 4
    }
    finally {
      if ($ptr -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
      if ($plainBytes -ne $null) { [System.Array]::Clear($plainBytes, 0, $plainBytes.Length) }
      if ($protectedBytes -ne $null) { [System.Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
    }
    if ([string]::IsNullOrEmpty($plain)) { exit 5 }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes('v=' + $plain)
    $out = [Console]::OpenStandardOutput()
    $out.Write($bytes, 0, $bytes.Length)
    $out.Flush()
    [System.Array]::Clear($bytes, 0, $bytes.Length)
    exit 0
  }

  'set' {
    $stdin = [Console]::OpenStandardInput()
    $buffer = New-Object System.IO.MemoryStream
    $chunk = New-Object byte[] 4096
    while ($true) {
      $read = $stdin.Read($chunk, 0, $chunk.Length)
      if ($read -le 0) { break }
      $buffer.Write($chunk, 0, $read)
    }
    [System.Array]::Clear($chunk, 0, $chunk.Length)
    $raw = $buffer.ToArray()
    $buffer.Dispose()
    # علامةُ ترتيب البايتات (EF BB BF) تسبق النصّ حين يكتب المُرسل بترميزٍ
    # ذي علامة — وهي ليست من السرّ. قارئ Rust لا يعرفها فيسلّمها للمزوّد
    # جزءاً من المفتاح: تُنزع هنا مرّةً واحدة قبل أيّ فحص.
    if ($raw.Length -ge 3 -and $raw[0] -eq 239 -and $raw[1] -eq 187 -and $raw[2] -eq 191) {
      $withoutMark = New-Object byte[] ($raw.Length - 3)
      [System.Array]::Copy($raw, 3, $withoutMark, 0, $raw.Length - 3)
      [System.Array]::Clear($raw, 0, $raw.Length)
      $raw = $withoutMark
    }
    # قصُّ الفراغ الأخير وحده — قارئ Rust يقصّه هو أيضاً قبل أن يقرأ، فالقصّ
    # هنا يجعل ما يُخزَّن هو عينُ ما سيُقرأ. سطرٌ أخيرٌ من أنبوبٍ ليس جزءاً
    # من السرّ، أمّا CR/LF **داخل** القيمة فيُرفض أدناه ولا يُقصّ.
    $end = $raw.Length
    while ($end -gt 0) {
      $last = $raw[$end - 1]
      if ($last -eq 13 -or $last -eq 10 -or $last -eq 32 -or $last -eq 9) { $end -= 1 } else { break }
    }
    if ($end -ne $raw.Length) {
      $trimmed = New-Object byte[] $end
      if ($end -gt 0) { [System.Array]::Copy($raw, $trimmed, $end) }
      [System.Array]::Clear($raw, 0, $raw.Length)
      $raw = $trimmed
    }
    if ($raw.Length -eq 0) { exit 5 }
    if ($raw.Length -gt 16384) { exit 6 }
    # قارئ Rust يرفض CR وLF وNUL — فالكتابة ترفضها هنا، لا هناك بعد فوات الأوان.
    foreach ($byte in $raw) { if ($byte -eq 13 -or $byte -eq 10 -or $byte -eq 0) { [System.Array]::Clear($raw, 0, $raw.Length); exit 7 } }
    $plain = [System.Text.Encoding]::UTF8.GetString($raw)
    [System.Array]::Clear($raw, 0, $raw.Length)
    $plainBytes = $null
    $protectedBytes = $null
    try {
      Protect-Directory $root
      # صيغةٌ ذات إصدار وDPAPI صريح: يمكن لأي عملية AbdoCode لنفس مستخدم
      # ويندوز قراءة الملف بعد إعادة التشغيل، ولا يملك مستخدم آخر مفتاح الفك.
      $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
      $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
        $plainBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      $armoured = 'dpapi-v1:' + [Convert]::ToBase64String($protectedBytes)
      [System.IO.File]::WriteAllText($file, $armoured)
    }
    catch {
      if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
      exit 10
    }
    finally {
      if ($plainBytes -ne $null) { [System.Array]::Clear($plainBytes, 0, $plainBytes.Length) }
      if ($protectedBytes -ne $null) { [System.Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
    }
    exit 0
  }

  'forget' {
    if (-not (Test-Path -LiteralPath $file)) { exit 1 }
    Remove-Item -LiteralPath $file -Force
    exit 0
  }

  'guard' {
    try { Protect-Directory $root } catch { exit 10 }
    exit 0
  }

  'list' {
    if (Test-Path -LiteralPath $root) {
      $names = Get-ChildItem -LiteralPath $root -Filter '*.sec' -File | ForEach-Object { $_.BaseName }
      $text = ($names -join "`n")
      if ($text.Length -gt 0) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
        $out = [Console]::OpenStandardOutput()
        $out.Write($bytes, 0, $bytes.Length)
        $out.Flush()
      }
    }
    exit 0
  }
}

exit 2

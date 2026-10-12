/**
 * 10-12 — نوافذُ اختبارات التحكّم الحيّة تظهر على شاشة المستخدم:
 * كانت بنفسجيّةً صارخة وبيضاءَ فارغة والرسّام. صارت كلُّها تدرّجاً برتقاليّاً خفيفاً واحداً، من هنا وحده.
 * السطورُ تُلحق بعد «$f = New-Object System.Windows.Forms.Form» في سكربت النافذة (المتغيّرُ $f).
 */
export const ORANGE_FORM: readonly string[] = Object.freeze([
  "Add-Type -AssemblyName System.Drawing",
  "$f.BackColor = [System.Drawing.Color]::FromArgb(255, 236, 214)",
  "$f.Add_Paint({ param($s, $e) $r = $s.ClientRectangle; if ($r.Width -gt 0 -and $r.Height -gt 0) { $br = New-Object System.Drawing.Drawing2D.LinearGradientBrush($r, [System.Drawing.Color]::FromArgb(255, 246, 234), [System.Drawing.Color]::FromArgb(255, 220, 178), [single]90); $e.Graphics.FillRectangle($br, $r); $br.Dispose() } })",
  "$f.Add_Resize({ param($s, $e) $s.Invalidate() })",
])

/** لونُ حقول النصّ داخل النوافذ (الحقلُ لا يرسم تدرّجاً): برتقاليٌّ أفتح. */
export const ORANGE_FIELD = "[System.Drawing.Color]::FromArgb(255, 248, 238)"

/** بكسلٌ من التدرّج — يُثبت أنّ اللقطةَ لقطةُ نافذتنا لا ما خلفها. */
export const isLightOrange = (r: number, g: number, b: number): boolean => r >= 238 && g >= 190 && g <= 250 && b >= 150 && b <= 242 && r - b >= 8

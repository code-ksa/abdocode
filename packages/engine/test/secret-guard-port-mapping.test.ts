/**
 * 10-08 (مقيس في بروفة النشر): `docker run -d -p 127.0.0.1:2222:22 test-server` رُفض «تمرير كلمة مرور» أربعَ مرّات — `-p` نشرُ منفذ.
 * والتوائم: كلمةُ مرور mysql بعد `-p` ملتصقةً أو بفراغ، وplink -pw، تبقى رفضاً وحجباً.
 */
import { expect, test } from "bun:test"
import { redactSecretValues, secretInCommandViolation } from "../src/secret-command-guard"

test("docker / podman port mappings after -p are not passwords", () => {
  for (const cmd of [
    "docker run -d -p 127.0.0.1:2222:22 test-server",
    "docker run -d --name web -p 8080:80 nginx",
    "docker run -p 127.0.0.1:5432:5432/tcp postgres",
    "podman run -p 3000:3000 app",
    "docker exec hello-deploy-test mkdir -p /root/.ssh",
    "mkdir -p src/components/ui",
    "npm install -p some-package-name",
  ]) expect(secretInCommandViolation(cmd)).toBeUndefined()
})

test("the twins: real passwords after -p and -pw are still refused and redacted", () => {
  expect(secretInCommandViolation("mysql -u root -pS3cretPass db")).toContain("كلمة مرور")
  expect(secretInCommandViolation("mysql -u root -p S3cretPass db")).toContain("كلمة مرور")
  expect(secretInCommandViolation("plink -pw hunter22 user@host")).toContain("كلمة مرور")
  expect(redactSecretValues("mysql -u root -pS3cretPass db").text).not.toContain("S3cretPass")
  expect(redactSecretValues("docker run -p 127.0.0.1:2222:22 img").text).toContain("127.0.0.1:2222:22")
})

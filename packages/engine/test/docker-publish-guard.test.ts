/**
 * 10-08 (مقيس في بروفة النشر): `docker run -d -P …` ⇦ 0.0.0.0:32768 تصلها الشبكةُ كلُّها. الحاويةُ المحلّيّة على 127.0.0.1 وحدها.
 * والتوائم: الربطُ على الحلقة المحلّيّة يمرّ، وما ليس docker run لا يُمسّ.
 */
import { expect, test } from "bun:test"
import { dockerPublishViolation } from "../src/shell-command-guard"

test("publishing on every interface is refused with the loopback form", () => {
  expect(dockerPublishViolation("docker run -d -P --name web hello-deploy")).toContain("-p 127.0.0.1:")
  expect(dockerPublishViolation("docker run -d -p 3000:3000 --name web hello-deploy")).toContain("-p 127.0.0.1:3000:3000")
  expect(dockerPublishViolation("docker run -p 8080 img")).toContain("-p 127.0.0.1:8080:8080")
  expect(dockerPublishViolation("docker run --publish=0.0.0.0:2222:22 img")).toContain("-p 127.0.0.1:2222:22")
  expect(dockerPublishViolation("podman run -p 5432:5432/tcp postgres")).toContain("127.0.0.1:5432:5432")
})

test("the twins: loopback bindings pass, and other commands are untouched", () => {
  expect(dockerPublishViolation("docker run -d -p 127.0.0.1:2222:22 test-server")).toBeUndefined()
  expect(dockerPublishViolation("docker run -d -p localhost:3000:3000 web")).toBeUndefined()
  expect(dockerPublishViolation("docker run --rm hello-world")).toBeUndefined()
  expect(dockerPublishViolation("docker ps -a")).toBeUndefined()
  expect(dockerPublishViolation("mysql -u root -p db")).toBeUndefined()
})

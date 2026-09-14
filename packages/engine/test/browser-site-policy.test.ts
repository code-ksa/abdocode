import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { browserSiteAllowed, desktopBrowserOwnership, ownedDesktopBrowserPort } from "../src/browser-site-policy"

test("an explicit desktop profile owns site policy even when engine settings live elsewhere", () => {
  const home=mkdtempSync(join(tmpdir(),"abdo-profile-policy-")),profile=join(home,"desktop"),settings=join(home,"engine-settings.json"),prior=process.env["ABDO_DESKTOP_PROFILE"];
  const port=9366,endpoint="ws://127.0.0.1:9366/devtools/browser/01234567-89ab-cdef-0123-456789abcdef";
  try {
    mkdirSync(profile);process.env["ABDO_DESKTOP_PROFILE"]=profile;
    writeFileSync(join(home,"workspace-v1.json"),JSON.stringify({preferences:{browserDefaultPermission:"allow"}}));
    expect(browserSiteAllowed(settings,"https://blocked.test")).toBe(false);
    expect(desktopBrowserOwnership(settings,port)!(endpoint)).toBe(false);
    writeFileSync(join(profile,"workspace-v1.json"),JSON.stringify({preferences:{blockedSites:["blocked.test"]}}));
    expect(browserSiteAllowed(settings,"https://blocked.test")).toBe(false);
    expect(browserSiteAllowed(settings,"https://allowed.test")).toBe(true);
    expect(desktopBrowserOwnership(settings,port)!(endpoint)).toBe(false);
    for(const invalid of ["", "relative", join(profile,"..","other")+"/../profile"]){process.env["ABDO_DESKTOP_PROFILE"]=invalid;expect(browserSiteAllowed(settings,"https://allowed.test")).toBe(false);expect(desktopBrowserOwnership(settings,port)!(endpoint)).toBe(false);}
  } finally {if(prior===undefined)delete process.env["ABDO_DESKTOP_PROFILE"];else process.env["ABDO_DESKTOP_PROFILE"]=prior;rmSync(home,{recursive:true,force:true})}
})

test("saved browser permissions apply immediately with exact host/subdomain boundaries and fail closed on invalid data", () => {
  const home = mkdtempSync(join(tmpdir(), "abdo-site-policy-")), settings = join(home, "engine-settings.json"), policy = join(home, "workspace-v1.json")
  const save = (preferences: object) => writeFileSync(policy, JSON.stringify({ preferences }))
  try {
    expect(browserSiteAllowed(settings, "https://allowed.test/a")).toBe(true)
    expect(browserSiteAllowed(settings, "file:///C:/private")).toBe(false)
    save({ browserDefaultPermission: "allow", blockedSites: ["blocked.test"] })
    for (const url of ["https://blocked.test", "http://sub.blocked.test/a", "https://BLOCKED.TEST.:443/path", "https://allowed.test@blocked.test"]) expect(browserSiteAllowed(settings, url)).toBe(false)
    for (const url of ["https://allowed.test", "https://notblocked.test", "https://blocked.test.allowed.test"]) expect(browserSiteAllowed(settings, url)).toBe(true)
    save({ browserDefaultPermission: "block", blockedSites: [] })
    expect(browserSiteAllowed(settings, "https://allowed.test")).toBe(false)
    save({ browserDefaultPermission: "allow", blockedSites: [] })
    expect(browserSiteAllowed(settings, "https://blocked.test")).toBe(true)
    writeFileSync(policy, "{")
    expect(browserSiteAllowed(settings, "https://allowed.test")).toBe(false)
    save({ blockedSites: [null] })
    expect(browserSiteAllowed(settings, "https://allowed.test")).toBe(false)
    writeFileSync(policy, " ".repeat(512 * 1024 + 1))
    expect(browserSiteAllowed(settings, "https://allowed.test")).toBe(false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test("docked navigation and popup handlers keep the existing saved policy as their owner", async () => {
  const source = await Bun.file(new URL("../../desktop/src-tauri/src/main.rs", import.meta.url)).text()
  const pane = source.slice(source.indexOf("fn pane_open("), source.indexOf("fn pane_bounds("))
  expect(pane).toContain(".on_navigation(")
  expect(pane).toContain("workspace::browser_navigation_allowed(&navigation_app, url.as_str())")
  expect(pane).toContain(".on_new_window(")
  expect(pane).toContain("workspace::browser_url_allowed(&popup_app, url.as_str())")
  expect(pane).toContain("pane.navigate(url)")
  expect(pane).toContain("NewWindowResponse::Deny")
  const open=source.slice(source.indexOf("fn browser_open("),source.indexOf("fn browser_close("))
  expect(open).toContain("browser_surface::launch(exe, &profile, PANE_PORT)")
  const nativeBrowser = await Bun.file(new URL("../../desktop/src-tauri/src/browser_surface.rs", import.meta.url)).text()
  expect(nativeBrowser).toContain('INITIAL_URL: &str = "about:blank"')
  expect(nativeBrowser).toContain('.arg(INITIAL_URL)')
  expect(open).not.toContain(".arg(&url)")
  const cli = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
  const surface = cli.slice(cli.indexOf("const runSurfaceTool ="), cli.indexOf("const turnServers ="))
  expect(surface).toContain("desktopBrowserOwnership(SETTINGS_FILE, port)")
  const launch=surface.slice(surface.indexOf("const browserPid ="))
  expect(launch).toContain('"--new-window", "about:blank"')
  expect(launch.indexOf("await browser.navigate(url)")).toBeGreaterThan(launch.indexOf("await browser.attach("))
  expect(surface.match(/new CdpBrowser\(port, /gu)).toHaveLength(2)
  expect(surface).toContain('if (!browserSiteAllowed(SETTINGS_FILE, rest)) return "Navigation blocked')
  expect(surface).toContain('if (!browserSiteAllowed(SETTINGS_FILE, url)) return "Navigation blocked')
})

test("desktop ownership leases reject stale, mismatched and missing browser identity before whole-browser attachment", () => {
  const home=mkdtempSync(join(tmpdir(),"abdo-browser-lease-")),settings=join(home,"engine-settings.json"),policy=join(home,"workspace-v1.json"),file=join(home,"browser-control-lease.json")
  const port=9366,endpoint="ws://127.0.0.1:9366/devtools/browser/01234567-89ab-cdef-0123-456789abcdef",owner=process.env["ABDO_DESKTOP_OWNER_PID"]
  const write=(patch:object={})=>writeFileSync(file,JSON.stringify({version:1,port,pid:process.pid,ownerPid:process.pid,endpoint,...patch}))
  try {
    expect(desktopBrowserOwnership(settings,port)).toBeUndefined()
    writeFileSync(policy,"{}")
    const owns=desktopBrowserOwnership(settings,port)!
    expect(owns(endpoint)).toBe(false)
    process.env["ABDO_DESKTOP_OWNER_PID"]=String(process.pid)
    write();expect(owns(endpoint)).toBe(true);expect(ownedDesktopBrowserPort(settings)).toBe(port)
    expect(owns(endpoint.replace("01234567","abcdef01"))).toBe(false)
    write({port:9367});expect(owns(endpoint)).toBe(false)
    write({ownerPid:2147483647});expect(owns(endpoint)).toBe(false)
    write({pid:2147483647});expect(owns(endpoint)).toBe(false);expect(ownedDesktopBrowserPort(settings)).toBeUndefined()
    write();process.env["ABDO_DESKTOP_OWNER_PID"]="2147483647";expect(owns(endpoint)).toBe(false)
    process.env["ABDO_DESKTOP_OWNER_PID"]=String(process.pid)
    const external=endpoint.replace("127.0.0.1","unrelated.test");write({endpoint:external});expect(owns(external)).toBe(false)
    writeFileSync(file,"{");expect(owns(endpoint)).toBe(false)
    writeFileSync(file," ".repeat(4097));expect(owns(endpoint)).toBe(false)
  } finally {if(owner===undefined)delete process.env["ABDO_DESKTOP_OWNER_PID"];else process.env["ABDO_DESKTOP_OWNER_PID"]=owner;rmSync(home,{recursive:true,force:true})}
})

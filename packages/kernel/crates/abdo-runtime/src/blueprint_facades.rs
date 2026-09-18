//! Generated compiled registry for original blueprint compatibility facades.

#[path = "actors/journal_actor.rs"]
pub mod element_001;
#[path = "actors/session_actor.rs"]
pub mod element_002;
#[path = "actors/worker_actor.rs"]
pub mod element_003;
#[path = "environment/build_manifest.rs"]
pub mod element_004;
#[path = "environment/image_ref.rs"]
pub mod element_005;
#[path = "environment/last_known_good.rs"]
pub mod element_006;
#[path = "environment/warm_pool_optional.rs"]
pub mod element_007;
#[path = "ipc/flow_control.rs"]
pub mod element_008;
#[path = "ipc/framing.rs"]
pub mod element_009;
#[path = "ipc/named_pipe.rs"]
pub mod element_010;
#[path = "ipc/peer_auth.rs"]
pub mod element_011;
#[path = "ipc/unix_socket.rs"]
pub mod element_012;
#[path = "ipc/version_negotiation.rs"]
pub mod element_013;
#[path = "platform/linux/cgroup_v2.rs"]
pub mod element_014;
#[path = "platform/linux/egress_broker.rs"]
pub mod element_015;
#[path = "platform/linux/landlock.rs"]
pub mod element_016;
#[path = "platform/linux/namespaces.rs"]
pub mod element_017;
#[path = "platform/linux/no_new_privs.rs"]
pub mod element_018;
#[path = "platform/linux/pidfd.rs"]
pub mod element_019;
#[path = "platform/linux/seccomp.rs"]
pub mod element_020;
#[path = "platform/macos/app_sandbox.rs"]
pub mod element_021;
#[path = "platform/macos/launch_constraints.rs"]
pub mod element_022;
#[path = "platform/macos/signed_xpc_workers.rs"]
pub mod element_023;
#[path = "platform/macos/tcc_ui_broker.rs"]
pub mod element_024;
#[path = "platform/windows/appcontainer_lpac.rs"]
pub mod element_025;
#[path = "platform/windows/exact_handle_list.rs"]
pub mod element_026;
#[path = "platform/windows/job_object.rs"]
pub mod element_027;
#[path = "platform/windows/keeper.rs"]
pub mod element_028;
#[path = "platform/windows/private_desktop.rs"]
pub mod element_029;
#[path = "platform/windows/process_identity.rs"]
pub mod element_030;
#[path = "platform/windows/restricted_token.rs"]
pub mod element_031;
#[path = "platform/windows/sandbox_feature_probe.rs"]
pub mod element_032;
#[path = "queues/backpressure.rs"]
pub mod element_033;
#[path = "queues/bounded_bytes.rs"]
pub mod element_034;
#[path = "queues/bounded_count.rs"]
pub mod element_035;
#[path = "queues/overload.rs"]
pub mod element_036;
#[path = "resources/cpu.rs"]
pub mod element_037;
#[path = "resources/handles.rs"]
pub mod element_038;
#[path = "resources/memory.rs"]
pub mod element_039;
#[path = "resources/output.rs"]
pub mod element_040;
#[path = "resources/pids.rs"]
pub mod element_041;
#[path = "resources/time.rs"]
pub mod element_042;
#[path = "scheduler/control_lane.rs"]
pub mod element_043;
#[path = "scheduler/resource_conflicts.rs"]
pub mod element_044;
#[path = "scheduler/weighted_fair.rs"]
pub mod element_045;
#[path = "supervisor/crash_loop.rs"]
pub mod element_046;
#[path = "supervisor/process.rs"]
pub mod element_047;
#[path = "supervisor/pty.rs"]
pub mod element_048;
#[path = "supervisor/watchdog.rs"]
pub mod element_049;
#[path = "supervisor/worker.rs"]
pub mod element_050;
#[path = "task_scope/abort_registry.rs"]
pub mod element_051;
#[path = "task_scope/cancellation_tree.rs"]
pub mod element_052;
#[path = "task_scope/task_tracker.rs"]
pub mod element_053;
#[path = "workers/claim.rs"]
pub mod element_054;
#[path = "workers/fence.rs"]
pub mod element_055;
#[path = "workers/lease.rs"]
pub mod element_056;
#[path = "workers/renew.rs"]
pub mod element_057;
#[path = "workers/suspend_resume.rs"]
pub mod element_058;

pub type BlueprintFacade = (&'static str, &'static str, fn() -> bool);
pub const FACADES: &[BlueprintFacade] = &[
    (
        element_001::BLUEPRINT_ELEMENT,
        element_001::CANONICAL_SOURCE,
        element_001::connected,
    ),
    (
        element_002::BLUEPRINT_ELEMENT,
        element_002::CANONICAL_SOURCE,
        element_002::connected,
    ),
    (
        element_003::BLUEPRINT_ELEMENT,
        element_003::CANONICAL_SOURCE,
        element_003::connected,
    ),
    (
        element_004::BLUEPRINT_ELEMENT,
        element_004::CANONICAL_SOURCE,
        element_004::connected,
    ),
    (
        element_005::BLUEPRINT_ELEMENT,
        element_005::CANONICAL_SOURCE,
        element_005::connected,
    ),
    (
        element_006::BLUEPRINT_ELEMENT,
        element_006::CANONICAL_SOURCE,
        element_006::connected,
    ),
    (
        element_007::BLUEPRINT_ELEMENT,
        element_007::CANONICAL_SOURCE,
        element_007::connected,
    ),
    (
        element_008::BLUEPRINT_ELEMENT,
        element_008::CANONICAL_SOURCE,
        element_008::connected,
    ),
    (
        element_009::BLUEPRINT_ELEMENT,
        element_009::CANONICAL_SOURCE,
        element_009::connected,
    ),
    (
        element_010::BLUEPRINT_ELEMENT,
        element_010::CANONICAL_SOURCE,
        element_010::connected,
    ),
    (
        element_011::BLUEPRINT_ELEMENT,
        element_011::CANONICAL_SOURCE,
        element_011::connected,
    ),
    (
        element_012::BLUEPRINT_ELEMENT,
        element_012::CANONICAL_SOURCE,
        element_012::connected,
    ),
    (
        element_013::BLUEPRINT_ELEMENT,
        element_013::CANONICAL_SOURCE,
        element_013::connected,
    ),
    (
        element_014::BLUEPRINT_ELEMENT,
        element_014::CANONICAL_SOURCE,
        element_014::connected,
    ),
    (
        element_015::BLUEPRINT_ELEMENT,
        element_015::CANONICAL_SOURCE,
        element_015::connected,
    ),
    (
        element_016::BLUEPRINT_ELEMENT,
        element_016::CANONICAL_SOURCE,
        element_016::connected,
    ),
    (
        element_017::BLUEPRINT_ELEMENT,
        element_017::CANONICAL_SOURCE,
        element_017::connected,
    ),
    (
        element_018::BLUEPRINT_ELEMENT,
        element_018::CANONICAL_SOURCE,
        element_018::connected,
    ),
    (
        element_019::BLUEPRINT_ELEMENT,
        element_019::CANONICAL_SOURCE,
        element_019::connected,
    ),
    (
        element_020::BLUEPRINT_ELEMENT,
        element_020::CANONICAL_SOURCE,
        element_020::connected,
    ),
    (
        element_021::BLUEPRINT_ELEMENT,
        element_021::CANONICAL_SOURCE,
        element_021::connected,
    ),
    (
        element_022::BLUEPRINT_ELEMENT,
        element_022::CANONICAL_SOURCE,
        element_022::connected,
    ),
    (
        element_023::BLUEPRINT_ELEMENT,
        element_023::CANONICAL_SOURCE,
        element_023::connected,
    ),
    (
        element_024::BLUEPRINT_ELEMENT,
        element_024::CANONICAL_SOURCE,
        element_024::connected,
    ),
    (
        element_025::BLUEPRINT_ELEMENT,
        element_025::CANONICAL_SOURCE,
        element_025::connected,
    ),
    (
        element_026::BLUEPRINT_ELEMENT,
        element_026::CANONICAL_SOURCE,
        element_026::connected,
    ),
    (
        element_027::BLUEPRINT_ELEMENT,
        element_027::CANONICAL_SOURCE,
        element_027::connected,
    ),
    (
        element_028::BLUEPRINT_ELEMENT,
        element_028::CANONICAL_SOURCE,
        element_028::connected,
    ),
    (
        element_029::BLUEPRINT_ELEMENT,
        element_029::CANONICAL_SOURCE,
        element_029::connected,
    ),
    (
        element_030::BLUEPRINT_ELEMENT,
        element_030::CANONICAL_SOURCE,
        element_030::connected,
    ),
    (
        element_031::BLUEPRINT_ELEMENT,
        element_031::CANONICAL_SOURCE,
        element_031::connected,
    ),
    (
        element_032::BLUEPRINT_ELEMENT,
        element_032::CANONICAL_SOURCE,
        element_032::connected,
    ),
    (
        element_033::BLUEPRINT_ELEMENT,
        element_033::CANONICAL_SOURCE,
        element_033::connected,
    ),
    (
        element_034::BLUEPRINT_ELEMENT,
        element_034::CANONICAL_SOURCE,
        element_034::connected,
    ),
    (
        element_035::BLUEPRINT_ELEMENT,
        element_035::CANONICAL_SOURCE,
        element_035::connected,
    ),
    (
        element_036::BLUEPRINT_ELEMENT,
        element_036::CANONICAL_SOURCE,
        element_036::connected,
    ),
    (
        element_037::BLUEPRINT_ELEMENT,
        element_037::CANONICAL_SOURCE,
        element_037::connected,
    ),
    (
        element_038::BLUEPRINT_ELEMENT,
        element_038::CANONICAL_SOURCE,
        element_038::connected,
    ),
    (
        element_039::BLUEPRINT_ELEMENT,
        element_039::CANONICAL_SOURCE,
        element_039::connected,
    ),
    (
        element_040::BLUEPRINT_ELEMENT,
        element_040::CANONICAL_SOURCE,
        element_040::connected,
    ),
    (
        element_041::BLUEPRINT_ELEMENT,
        element_041::CANONICAL_SOURCE,
        element_041::connected,
    ),
    (
        element_042::BLUEPRINT_ELEMENT,
        element_042::CANONICAL_SOURCE,
        element_042::connected,
    ),
    (
        element_043::BLUEPRINT_ELEMENT,
        element_043::CANONICAL_SOURCE,
        element_043::connected,
    ),
    (
        element_044::BLUEPRINT_ELEMENT,
        element_044::CANONICAL_SOURCE,
        element_044::connected,
    ),
    (
        element_045::BLUEPRINT_ELEMENT,
        element_045::CANONICAL_SOURCE,
        element_045::connected,
    ),
    (
        element_046::BLUEPRINT_ELEMENT,
        element_046::CANONICAL_SOURCE,
        element_046::connected,
    ),
    (
        element_047::BLUEPRINT_ELEMENT,
        element_047::CANONICAL_SOURCE,
        element_047::connected,
    ),
    (
        element_048::BLUEPRINT_ELEMENT,
        element_048::CANONICAL_SOURCE,
        element_048::connected,
    ),
    (
        element_049::BLUEPRINT_ELEMENT,
        element_049::CANONICAL_SOURCE,
        element_049::connected,
    ),
    (
        element_050::BLUEPRINT_ELEMENT,
        element_050::CANONICAL_SOURCE,
        element_050::connected,
    ),
    (
        element_051::BLUEPRINT_ELEMENT,
        element_051::CANONICAL_SOURCE,
        element_051::connected,
    ),
    (
        element_052::BLUEPRINT_ELEMENT,
        element_052::CANONICAL_SOURCE,
        element_052::connected,
    ),
    (
        element_053::BLUEPRINT_ELEMENT,
        element_053::CANONICAL_SOURCE,
        element_053::connected,
    ),
    (
        element_054::BLUEPRINT_ELEMENT,
        element_054::CANONICAL_SOURCE,
        element_054::connected,
    ),
    (
        element_055::BLUEPRINT_ELEMENT,
        element_055::CANONICAL_SOURCE,
        element_055::connected,
    ),
    (
        element_056::BLUEPRINT_ELEMENT,
        element_056::CANONICAL_SOURCE,
        element_056::connected,
    ),
    (
        element_057::BLUEPRINT_ELEMENT,
        element_057::CANONICAL_SOURCE,
        element_057::connected,
    ),
    (
        element_058::BLUEPRINT_ELEMENT,
        element_058::CANONICAL_SOURCE,
        element_058::connected,
    ),
];

#[cfg(test)]
mod tests {
    #[test]
    fn every_facade_is_connected() {
        assert!(!super::FACADES.is_empty());
        assert!(super::FACADES.iter().all(|(_, _, connected)| connected()));
    }
}

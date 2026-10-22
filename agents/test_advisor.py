from fixwise_agent.advisor import handle_payload


def test_offline_advice_for_geyser():
    out = handle_payload({"issue": {"summary": "geyser leaking", "home": {"job": "Geyser leak or failure"}}})
    assert out["source"] == "deterministic" and "tank" in out["advice"]


def test_bad_payload_is_safe():
    assert handle_payload("nonsense")["advice"]


def test_summary_is_truncated():
    from fixwise_agent.advisor import _facts
    assert len(_facts({"issue": {"summary": "x" * 5000}})["summary"]) == 400

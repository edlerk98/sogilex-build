-- Owner's decision (2026-11-22): everyone on the Beta plan may publish a website (name.sogilex.net) and an online
-- menu. Safe to re-run. The free trial still can't publish. Open item from the security review: contact-form spam via
-- direct submit_site_message calls (30 per site per hour cap still holds).
update public.plans set can_publish = true where id = 'beta';

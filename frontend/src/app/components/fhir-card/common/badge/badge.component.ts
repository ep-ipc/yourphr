import {Component, Input, OnInit} from '@angular/core';
@Component({
  standalone: true,
  selector: 'fhir-ui-badge',
  templateUrl: './badge.component.html',
  styleUrls: ['./badge.component.scss']
})
export class BadgeComponent implements OnInit {
  @Input() status = ""

  constructor() { }

  ngOnInit(): void {
  }

  // text-bg-* rather than bg-* (yourphr#486).
  //
  // bg-* sets ONLY a background. This theme replaces Bootstrap's .badge rule with one that
  // defines geometry and typography and NO color, so the text colour was inherited from the
  // surrounding row — white in dark mode, and white again on a highlighted row in light mode.
  // White on light grey is what an "unknown" status looked like.
  //
  // text-bg-* pairs each background with a contrast colour Bootstrap computes per variant
  // (secondary/success/warning/info get #000, primary/danger get #fff). Safe in BOTH modes here
  // because the dark theme uses its own --dark-* custom properties and does not redefine
  // --bs-*-rgb, so a variant's background is the same colour in either mode.
  getBadgeStatusColor(status): string {
    const lookup = {
      // condition
      active: 'text-bg-primary',
      recurrence: '',
      relapse: 'text-bg-info',
      inactive: 'text-bg-secondary',
      remission: 'text-bg-info',
      resolved: 'text-bg-primary',
      // immunization
      'in-progress': 'text-bg-warning',
      'on-hold': 'text-bg-secondary',
      completed: 'text-bg-success',
      'entered-in-error': 'text-bg-danger',
      stopped: 'text-bg-secondary',
      'not-done': 'text-bg-warning',
      // procedure
      preparation: 'text-bg-primary',
      suspended: '',
      aborted: '',
      unknown: 'text-bg-secondary',
      // practitioner
      // allergy intolerance
      unconfirmed: '',
      confirmed: '',
      refuted: '',
      // appointment
      proposed: '',
      pending: '',
      booked: '',
      arrived: '',
      fulfilled: '',
      cancelled: '',
      noshow: '',
      'checked-in': '',
      waitlist: '',
      // care plan
      draft: '',
      revoked: '',
      // care team
      // claim
      // claim response
      // device
      available: '',
      'not-available': '',
      // diagnostic report
      registered: '',
      partial: '',
      preliminary: '',
      final: '',
      corrected: '',
      appended: '',
      // document reference
      current: '',
      superseded: '',
      // encounter
      planned: '',
      triaged: '',
      onleave: '',
      finished: '',
      // explanation of benefit
      // family member history
      'health-unknown': '',
      // goal
      accepted: '',
      rejected: '',
      achieved: '',
      sustaining: '',
      'on-target': '',
      'ahead-of-target': '',
      'behind-target': '',
      // list
      retired: '',
      // location
      // mediacation
      brand: '',
      // medication administration
      // medication knowledge
      // medication statement
      intended: '',
      'not-taken': '',
      // observation
      amended: '',
      // procedure
      // questionnaire
      published: '',
      // questionnaire response
      // research study
      'administratively-completed': '',
      approved: '',
      'closed-to-accrual': '',
      'closed-to-accrual-and-intervention': '',
      disapproved: '',
      'in-review': '',
      'temporarily-closed-to-accrual': '',
      'temporarily-closed-to-accrual-and-intervention': '',
      withdrawn: '',
    };
    return lookup[status] || 'text-bg-secondary'
  }

}

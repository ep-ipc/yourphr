import {Component, OnInit} from '@angular/core';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {RouterModule} from '@angular/router';
import {FastenApiService} from '../../services/fasten-api.service';
import {RelayConfig, RelayResolvedValue} from '../../models/fasten/relay-config';
import {InstanceSettings} from '../../models/fasten/instance-settings';

// Admin Dashboard (#170): the single admin hub — a grid of cards, each linking to a dedicated admin
// page (Sandbox Testing, Provider Catalog, Server Logs, …). The route is gated by IsAdminAuthGuard and
// each target page + backend endpoint also self-gates on the admin role. Every linked page carries a
// shared <app-admin-back-link> back to here.
//
// Instance / operator contact is an *inline* card (like SMART relay): a few fields, no subpage.
@Component({
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  selector: 'app-admin-dashboard',
  templateUrl: './admin-dashboard.component.html',
  styleUrls: ['./admin-dashboard.component.scss'],
})
export class AdminDashboardComponent implements OnInit {
  // SMART relay configuration (#402). Rendered inline rather than behind another click: the point is
  // seeing at a glance whether this deployment's relay settings are actually in effect BEFORE
  // starting a provider connection that would otherwise fail mid-OAuth.
  relayConfig: RelayConfig | null = null;
  relayError = '';
  relayLoading = false;

  // Collapsed by default — this is reference detail, not something to read on every visit. The
  // Ready/Not ready badge stays in the header either way, so the signal that you NEED to look is
  // never hidden by collapsing.
  relayExpanded = false;

  // Instance operator contact — who runs this deployment (privacy / wipe / help).
  instance: InstanceSettings = {name: '', contact_email: '', contact_url: ''};
  instanceLoading = false;
  instanceSaving = false;
  instanceError = '';
  instanceSaved = false;

  toggleRelay(): void {
    this.relayExpanded = !this.relayExpanded;
  }

  constructor(private fastenApi: FastenApiService) {}

  ngOnInit(): void {
    this.relayLoading = true;
    this.fastenApi.getRelayConfig().subscribe(
      (cfg) => { this.relayConfig = cfg },
      (_err) => { this.relayError = 'Could not load the relay configuration.'; this.relayLoading = false },
      () => { this.relayLoading = false },
    );

    this.instanceLoading = true;
    this.fastenApi.getInstanceSettings().subscribe(
      (s) => {
        this.instance = {
          name: s?.name || '',
          contact_email: s?.contact_email || '',
          contact_url: s?.contact_url || '',
        };
      },
      (_err) => {
        this.instanceError = 'Could not load instance settings.';
        this.instanceLoading = false;
      },
      () => { this.instanceLoading = false },
    );
  }

  saveInstance(): void {
    this.instanceError = '';
    this.instanceSaved = false;
    this.instanceSaving = true;
    const payload: InstanceSettings = {
      name: (this.instance.name || '').trim(),
      contact_email: (this.instance.contact_email || '').trim(),
      contact_url: (this.instance.contact_url || '').trim(),
    };
    this.fastenApi.setInstanceSettings(payload).subscribe(
      (s) => {
        this.instance = {
          name: s?.name || '',
          contact_email: s?.contact_email || '',
          contact_url: s?.contact_url || '',
        };
        this.instanceSaved = true;
        this.instanceSaving = false;
      },
      (err) => {
        const msg = err?.error?.error || err?.message || 'Save failed.';
        this.instanceError = typeof msg === 'string' ? msg : 'Save failed.';
        this.instanceSaving = false;
      },
    );
  }

  // Plain-language explanation of where a value came from. "default" and "inherited" are the cases
  // worth surfacing: they mean the operator's own setting is NOT being used, which today looks
  // identical to a working configuration.
  sourceLabel(v: RelayResolvedValue | undefined): string {
    switch (v?.source) {
      case 'configured': return 'set by you';
      case 'inherited':  return 'inherited — not set directly';
      case 'default':    return 'built-in default — your setting is NOT in use';
      case 'unset':      return 'not set';
      default:           return 'unknown';
    }
  }

  // Badge colour: green only when the value came from explicit configuration.
  sourceBadgeClass(v: RelayResolvedValue | undefined): string {
    switch (v?.source) {
      case 'configured': return 'badge-success';
      case 'inherited':  return 'badge-info';
      case 'default':    return 'badge-warning';
      default:           return 'badge-danger';
    }
  }
}

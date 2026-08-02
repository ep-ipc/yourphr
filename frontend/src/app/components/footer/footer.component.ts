import { Component, OnInit } from '@angular/core';
import {environment} from '../../../environments/environment';
import {FastenApiService} from '../../services/fasten-api.service';

@Component({
    selector: 'app-footer',
    templateUrl: './footer.component.html',
    styleUrls: ['./footer.component.scss'],
    standalone: false
})
export class FooterComponent implements OnInit {
  // Shows "<env>-<semver>" of the RUNNING backend, e.g. "demo-1.18.2" / "prod-1.18.2".
  // Environment label prefers the backend runtime config (YOURPHR_WEB_ENVIRONMENT_NAME) so one
  // release image can label prod/demo/dev differently; falls back to the Angular build-time name.
  appVersion: string = environment.environment_name;
  currentYear: number = new Date().getFullYear();

  // Who runs THIS instance (#454). The operator is the data controller for the records held
  // here, so a patient needs a way to reach them. All three are empty until an operator fills
  // in the Admin Dashboard Instance card — nothing is rendered in that case, and nothing is
  // invented as a stand-in.
  operatorName = '';
  operatorContactEmail = '';
  operatorContactUrl = '';

  constructor(private fastenApi: FastenApiService) {}

  // True only when there is something real to show, so an unconfigured instance renders the
  // footer exactly as before.
  get hasOperatorContact(): boolean {
    return !!(this.operatorName || this.operatorContactEmail || this.operatorContactUrl);
  }

  ngOnInit() {
    this.fastenApi.getVersion().subscribe({
      next: ({ version, environment_name }) => {
        const env = environment_name || environment.environment_name || 'prod';
        this.appVersion = `${env}-${version}`;
      },
      error: () => { /* keep the channel-only fallback */ },
    });

    this.fastenApi.getPublicInstanceInfo().subscribe({
      next: ({ name, contact_email, contact_url }) => {
        this.operatorName = name;
        this.operatorContactEmail = contact_email;
        this.operatorContactUrl = contact_url;
      },
      error: () => { /* an instance with no operator contact set is the normal case */ },
    });
  }

}

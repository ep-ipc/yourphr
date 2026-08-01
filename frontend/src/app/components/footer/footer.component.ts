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

  constructor(private fastenApi: FastenApiService) {}

  ngOnInit() {
    this.fastenApi.getVersion().subscribe({
      next: ({ version, environment_name }) => {
        const env = environment_name || environment.environment_name || 'prod';
        this.appVersion = `${env}-${version}`;
      },
      error: () => { /* keep the channel-only fallback */ },
    });
  }

}

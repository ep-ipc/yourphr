import {Component, Input, OnInit, TemplateRef, ViewChild} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {ResourceFhir} from '../../models/fasten/resource_fhir';
import {FastenApiService} from '../../services/fasten-api.service';
import * as fhirpath from 'fhirpath';
import {PractitionerModel} from '../../../lib/models/resources/practitioner-model';
import {Summary} from '../../../app/models/fasten/summary';

@Component({
    selector: 'report-header',
    templateUrl: './report-header.component.html',
    styleUrls: ['./report-header.component.scss'],
    standalone: false
})
export class ReportHeaderComponent implements OnInit {
  patient: ResourceFhir = null
  primaryCare: PractitionerModel = null
  lastUpdated: Date = null
  @Input() reportHeaderTitle = ""
  @Input() reportHeaderSubTitle = "Organized by condition and encounters"
  @ViewChild('saveReportWarning') saveReportWarning: TemplateRef<any>

  constructor(
    private fastenApi: FastenApiService,
    private modalService: NgbModal,
  ) { }

  ngOnInit(): void {
    this.fastenApi.getSummary().subscribe((summary: Summary) => {
      if (summary.sources && summary.sources.length > 0) {
        this.lastUpdated = summary.sources.reduce((latest, source) => {
          const sourceDate = new Date(source.updated_at);
          return sourceDate > latest ? sourceDate : latest;
        }, new Date(0));
      }
    })
    this.fastenApi.getResources("Patient").subscribe(results => {
      this.patient = results[0]
      if(!this.patient) return

      const primaryCareId = fhirpath.evaluate(this.patient?.resource_raw, "Patient.generalPractitioner.reference.first()")
      if(primaryCareId){
        const primaryCareIdStr = primaryCareId.join("")
        const primaryCareIdParts = primaryCareIdStr.split("/")
        if(primaryCareIdParts.length == 2) {
          this.fastenApi.getResources(primaryCareIdParts[0], this.patient?.source_id,  primaryCareIdParts[1]).subscribe(primaryResults => {
            if (primaryResults.length > 0){
              this.primaryCare = new PractitionerModel(primaryResults[0].resource_raw)
            }
          })
        }
      }
    })
  }
  getIPSExport(event: Event){
    event.preventDefault()
    return this.fastenApi.getIPSExport("pdf")
  }

  /**
   * Save Report downloads the whole record as a self-contained HTML file (#523).
   *
   * Warn FIRST, and say what is actually at stake. A patient exporting their record is doing a
   * normal thing, but the file that lands in Downloads is their complete medical history in the
   * clear — no password, no expiry — and it will be backed up, synced and shared as casually as any
   * other download. That is worth one sentence before it happens, not a scare dialog after.
   *
   * Deliberately not a browser confirm(): it cannot say this much, and it is not styleable.
   */
  saveReport(event: Event){
    event.preventDefault()
    this.modalService.open(this.saveReportWarning, {ariaLabelledBy: 'save-report-title'}).result.then(
      () => this.fastenApi.getIPSExport("html"),
      () => {}, // dismissed — nothing to do
    )
  }

}

import {Component, EventEmitter, OnInit, Optional, Output, TemplateRef, ViewChild} from '@angular/core';
import {ConnectGatewayService} from '../../services/connect-gateway.service';
import {FastenApiService} from '../../services/fasten-api.service';
import {ConnectGatewaySourceMetadata} from '../../models/connect-gateway/connect-gateway-source-metadata';
import {Source} from '../../models/fasten/source';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {ActivatedRoute} from '@angular/router';
import {environment} from '../../../environments/environment';
import {CDAConverterStatus} from '../../models/fasten/cda-converter-status';
import {BehaviorSubject, forkJoin, Observable, of, Subject} from 'rxjs';
import {
  ConnectGatewaySourceSearch,
  ConnectGatewaySourceSearchAggregation,
  ConnectGatewayBrandListDisplayItem
} from '../../models/connect-gateway/connect-gateway-source-search';
import {debounceTime, distinctUntilChanged, pairwise, startWith} from 'rxjs/operators';
import {MedicalSourcesFilter, MedicalSourcesFilterService} from '../../services/medical-sources-filter.service';
import {FormControl, FormGroup} from '@angular/forms';
import * as _ from 'lodash';
import {PatientAccessBrand} from '../../models/patient-access-brands';
import {FormRequestHealthSystemComponent} from '../../components/form-request-health-system/form-request-health-system.component';
import {extractErrorFromResponse} from '../../../lib/utils/error_extract';
import {
  formatSmartConnectFailure,
  isRetryableSmartConnectError,
} from '../../../lib/utils/smart-connect-error';
import {ConnectableProvider} from '../../models/fasten/provider-catalog';
import {SmartAuthorizeResponse} from '../../models/fasten/smart-authorize';
import {LegalConsentStatus} from '../../models/fasten/legal-consent';
import {AttributionNotice, attributionsForContext} from '../../models/fasten/attributions';
import {MEDICARE_PRE_CONNECT} from '../../models/fasten/medicare-connect-copy';

// Max time to wait for the patient to finish logging in at the provider (relay-poll phase, across
// retries). A first login can be slow (read consent, pick account, authorize) — allow several
// minutes. Does NOT bound the data download, which runs in the background after connect returns.
const catalogConnectWindowMs = 4 * 60 * 1000 // 4 minutes
// Default single connect poll window when authorize omits relay_poll_seconds (matches backend #406).
const defaultRelayPollSeconds = 55

export class SourceListItem {
  source?: Source
  brand: ConnectGatewayBrandListDisplayItem | PatientAccessBrand
  searchHighlights?: string[]
  // Resolved patient display name for this source (e.g. "Camila Lopez"), shown on the connected tile.
  patientName?: string
}

@Component({
    selector: 'app-medical-sources',
    templateUrl: './medical-sources.component.html',
    styleUrls: ['./medical-sources.component.scss'],
    standalone: false
})
export class MedicalSourcesComponent implements OnInit {
  loading = false

  environment_name = environment.environment_name

  uploadedFile: File[] = []
  uploadErrorMsg = ""
  // true from the moment the bundle is sent until the server has accepted it and queued the import
  // (the import itself then runs in the background — progress shows on the Connected Sources list).
  uploadInProgress = false
  dragActive = false

  searchTermUpdate = new BehaviorSubject<string>("");
  status: Record<string, undefined | "token" | "authorize"> = {}

  //aggregation/filter data & limits
  globalLimits: {
    // aggregations: ConnectGatewaySourceSearchAggregations | undefined,
  } = {
    // categories: [],
    // aggregations: undefined,
  }




  //source of truth for current state
  //TODO: see if we can remove this without breaking search/filtering
  filterForm = this.filterService.filterForm;

  //modal
  modalSelectedBrandListItem: ConnectGatewayBrandListDisplayItem | PatientAccessBrand = null;
  modalCloseResult = '';


  // CCDA-FHIR modal
  @ViewChild('ccdaWarningModalRef') ccdaWarningModalRef : any;
  // Pre-connect informed messaging for Medicare (#430) — only after PP/ToS consent (#427)
  @ViewChild('medicarePreConnectModalRef') medicarePreConnectModalRef: TemplateRef<any>;

  // Whether this server can convert C-CDA at all (#397). null = not yet checked, or the check
  // failed — in that case the modal behaves as it always did and lets the upload surface any error.
  cdaConverterStatus: CDAConverterStatus | null = null;

  // gates <app-medical-sources-connected> rendering
  showConnectedList = true

  // Provider catalog (#306): the admin-configured providers a patient can pick to connect — no
  // credentials are ever shown or sent; the backend resolves client_id/secret server-side.
  connectableProviders: ConnectableProvider[] = []
  connectableLoading = false
  connectingProviderId: string | null = null   // the catalog id currently mid-connect (disables its button)
  connectErrorMsg = ""
  connectSuccessMsg = ""
  // Legal consent for Medicare-class providers (#427)
  legalConsent: LegalConsentStatus | null = null
  legalConsentLoading = false
  // CMS / partner attribution for Medicare-class connect (#428)
  medicareAttributions: AttributionNotice[] = attributionsForContext('medicare-connect')
  // Modal copy + pending provider while pre-connect dialog is open (#430)
  medicarePreConnect = MEDICARE_PRE_CONNECT
  pendingMedicareProvider: ConnectableProvider | null = null

  constructor(
    private connectGatewayApi: ConnectGatewayService,
    private fastenApi: FastenApiService,
    private activatedRoute: ActivatedRoute,
    private filterService: MedicalSourcesFilterService,
    private modalService: NgbModal,

  ) {
  }

  ngOnInit(): void {
    this.loadConnectableProviders()
    this.loadLegalConsent()
  }

  // Loads the patient-facing provider picker (enabled catalog entries; credential-free). A failure
  // is non-fatal — the page still offers manual upload — so it's logged, not surfaced as an error.
  private loadConnectableProviders(): void {
    this.connectableLoading = true
    this.fastenApi.listConnectableProviders().subscribe(
      (providers) => { this.connectableProviders = providers || [] },
      (err) => { console.log("could not load connectable providers", err); this.connectableLoading = false },
      () => { this.connectableLoading = false },
    )
  }

  private loadLegalConsent(): void {
    this.legalConsentLoading = true
    this.fastenApi.getLegalConsent().subscribe(
      (s) => { this.legalConsent = s; this.legalConsentLoading = false },
      (_err) => { this.legalConsentLoading = false },
    )
  }

  /** True when this provider needs PP/ToS and the user has not accepted yet. */
  needsLegalConsent(provider: ConnectableProvider): boolean {
    if (!provider?.requires_legal_consent) { return false }
    return !this.legalConsent?.accepted
  }

  get showMedicareConsentBanner(): boolean {
    if (this.legalConsent?.accepted) { return false }
    return this.connectableProviders.some((p) => !!p.requires_legal_consent)
  }

  /** CMS attribution when any Medicare-class provider is on the picker (#428). */
  get showMedicareAttribution(): boolean {
    return this.connectableProviders.some((p) => !!p.requires_legal_consent)
      && this.medicareAttributions.length > 0
  }

  // Connects an admin-configured provider by id. The patient never sees or sends a client_id/secret:
  // the backend fills them from the catalog.
  //
  // Order for Medicare-class providers (#427 / #430):
  //   1) PP/ToS must already be granted (button disabled otherwise; hard-check here).
  //   2) Pre-connect informed modal — Cancel aborts; Continue (same click) starts OAuth.
  //   3) OAuth popup opens in the Continue click handler (user gesture — avoids popup blockers).
  public async connectCatalogProvider(provider: ConnectableProvider): Promise<void> {
    if (this.connectingProviderId) { return } // guard against double-submit
    this.connectErrorMsg = ""
    this.connectSuccessMsg = ""

    // #427: never open OAuth (or pre-connect modal) without active PP/ToS consent.
    if (this.needsLegalConsent(provider)) {
      this.connectErrorMsg = 'Accept the Privacy Policy and Terms of Service on Account Profile before connecting Medicare.'
      return
    }

    // #430: informed message before authorize (Medicare-class only). Non-Medicare goes straight to OAuth.
    if (provider.requires_legal_consent) {
      this.pendingMedicareProvider = provider
      try {
        await this.modalService.open(this.medicarePreConnectModalRef, {
          ariaLabelledBy: 'medicare-preconnect-title',
          backdrop: 'static',
        }).result
        // Continue starts OAuth in confirmMedicarePreConnect (same click as window.open).
        // Cancel/dismiss rejects — nothing more to do.
      } catch {
        this.pendingMedicareProvider = null
      }
      return
    }

    await this.runCatalogOAuthConnect(provider)
  }

  // Continue on the pre-connect modal: close + start OAuth in this click (popup-blocker safe).
  confirmMedicarePreConnect(modal: {close: (r: string) => void}): void {
    const provider = this.pendingMedicareProvider
    modal.close('continue')
    this.pendingMedicareProvider = null
    if (provider) {
      void this.runCatalogOAuthConnect(provider)
    }
  }

  // Popup must open in the same user-gesture stack as the Continue/click that starts OAuth.
  private async runCatalogOAuthConnect(provider: ConnectableProvider): Promise<void> {
    const popup = window.open('', '_blank')
    if (!popup) {
      this.connectErrorMsg = 'Your browser blocked the login popup. Please allow popups for this site, then try again.'
      return
    }
    try {
      popup.document.write('<!doctype html><title>Connecting…</title><p style="font:14px sans-serif;padding:1rem">Preparing secure sign-in…</p>')
    } catch (_) { /* popup not navigable yet */ }

    this.connectingProviderId = provider.id
    try {
      // No redirect_uri is sent: the backend derives it from this deployment's relay config, so a
      // self-hosted relay works without a frontend rebuild (#399). Echo back what it used.
      const authorize: SmartAuthorizeResponse = await this.fastenApi
        .authorizeSourceFromCatalog(provider.id).toPromise()

      if (!authorize?.authorize_url || !authorize?.state || !authorize?.code_verifier) {
        popup.close()
        this.connectErrorMsg = 'Could not start the connection: the server did not return a valid sign-in URL.'
        return
      }
      popup.location.href = authorize.authorize_url

      // Backend polls the relay for relay_poll_seconds (default 55) per connect attempt, then
      // exchanges. A slow login can outlast one poll, so retry across the login window. Only true
      // poll timeouts are retried (#406) — secret/config errors must not spin for minutes.
      const windowMs = (authorize.login_wait_seconds && authorize.login_wait_seconds > 0)
        ? authorize.login_wait_seconds * 1000
        : catalogConnectWindowMs
      const pollSec = (authorize.relay_poll_seconds && authorize.relay_poll_seconds > 0)
        ? authorize.relay_poll_seconds
        : defaultRelayPollSeconds
      const maxAttempts = Math.max(1, Math.ceil(windowMs / (pollSec * 1000)))
      let lastErr: any = null
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await this.fastenApi.connectSourceFromCatalog(provider.id, {
            state: authorize.state,
            code_verifier: authorize.code_verifier,
            redirect_uri: authorize.redirect_uri,
            display: provider.display,
          }).toPromise()
          lastErr = null
          break
        } catch (err) {
          lastErr = err
          if (!isRetryableSmartConnectError(err)) { break }
        }
      }

      if (lastErr) {
        this.connectErrorMsg = formatSmartConnectFailure(lastErr)
        return
      }

      this.connectSuccessMsg = `Connected to ${provider.display}. Your records are being imported.`
      this.refreshConnectedList()
    } catch (err) {
      this.connectErrorMsg = formatSmartConnectFailure(err)
    } finally {
      this.connectingProviderId = null
    }
  }

  // Forces <app-medical-sources-connected> to re-render so a freshly connected source shows up.
  private refreshConnectedList(): void {
    this.showConnectedList = false
    setTimeout(() => { this.showConnectedList = true }, 0)
  }



  //OLD FUNCTIONS
  //
  //
  // private populateAvailableSourceList(results: ConnectGatewaySourceSearch): void {
  //   console.log("AGGREGATIONS!!!!!", results.aggregations)
  //   this.totalAvailableSourceList = results.hits.total.value
  //   if(results.hits.hits.length == 0){
  //     this.scrollComplete = true
  //     console.log("scroll complete")
  //     return
  //   }
  //   this.scrollId = results._scroll_id
  //   this.availableSourceList = this.availableSourceList.concat(results.hits.hits.map((result) => {
  //     return {metadata: result._source}
  //   }).filter((item) => {
  //     return !this.connectedSourceList.find((connectedItem) => connectedItem.metadata.source_type == item.metadata.source_type)
  //   }))
  // }
  //


  // /**
  //  * after pressing the logo (connectModalHandler button), this function will display a modal with information about the source
  //  * @param $event
  //  * @param sourceType
  //  */
  public connectModalHandler(contentModalRef, sourceListItem: SourceListItem) :void {
    console.log("TODO: connect Handler")


    this.modalSelectedBrandListItem = sourceListItem.brand
    this.modalService.open(contentModalRef, {ariaLabelledBy: 'modal-basic-title'}).result.then((result) => {
      this.modalSelectedBrandListItem = null
      this.modalCloseResult = `Closed with: ${result}`;
    }, (reason) => {
      this.modalSelectedBrandListItem = null
    });
  }

  // /**
  //  * after pressing the connect button in the Modal, this function will generate an authorize url for this source, and redirect the user.
  //  * @param $event
  //  * @param sourceType
  //  */
  public connectHandler($event, brandId: string, portalId: string, endpointId: string): void {

    ($event.currentTarget as HTMLButtonElement).disabled = true;
    this.status[brandId] = "authorize"
    this.status[endpointId] = "authorize"

    this.connectGatewayApi.getConnectGatewaySource(endpointId)
      .then(async (sourceMetadata: ConnectGatewaySourceMetadata) => {
        sourceMetadata.brand_id = brandId
        sourceMetadata.portal_id = portalId

        const authorizationUrl = await this.connectGatewayApi.generateSourceAuthorizeUrl(sourceMetadata)

        // redirect to the connect gateway with uri's (or open a new window in desktop mode)
        this.connectGatewayApi.redirectWithOriginAndDestination(authorizationUrl.toString(), sourceMetadata).subscribe((desktopRedirectData) => {
          if(!desktopRedirectData){
            return //wait for redirect
          }

          //Note: this code will only run in Desktop mode (with popups)
          //in non-desktop environments, the user is redirected in the same window, and this code is never executed.

          //always close the modal
          this.modalService.dismissAll()

          //redirect the browser back to this page with the code in the query string parameters
          this.connectGatewayApi.redirectWithDesktopCode(desktopRedirectData.state, desktopRedirectData.codeData)
        })
      });
  }



  /**
   * this function is used to process manually "uploaded" FHIR bundle files, adding them to the database.
   * @param event
   */
  // Native file <input> change: read files, then reset value so re-selecting the same file fires again.
  public onBundleInput(input: HTMLInputElement) {
    this.handleBundleFiles(input.files)
    input.value = ""
  }

  // Drag-and-drop onto the upload zone.
  public onBundleDrop(event: DragEvent) {
    event.preventDefault()
    this.dragActive = false
    this.handleBundleFiles(event.dataTransfer?.files ?? null)
  }

  private handleBundleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) { return }
    this.uploadSourceBundleHandler(Array.from(fileList))
  }

  public async uploadSourceBundleHandler(files: File[]) {
    this.uploadErrorMsg = ""
    let processingFile = files[0] as File
    this.uploadedFile = [processingFile]

    // C-CDA / CCD documents are converted to FHIR on the server (#254) by the self-hosted
    // fhir-converter — the raw document is uploaded as-is and never leaves this instance.
    // (Previously the browser shipped the CCDA to a third-party cloud; that path is gone.)
    if(this.isCcdaFile(processingFile)){
      // Ask the server whether conversion can actually happen BEFORE offering it. Otherwise the
      // modal promises a conversion that the upload then rejects with a config error (#397).
      try {
        this.cdaConverterStatus = await this.fastenApi.getCDAConverterStatus().toPromise()
      } catch (_) {
        this.cdaConverterStatus = null // status unknown — fall back to offering it, as before
      }
      const shouldConvert = await this.showCcdaWarningModal()
      if(!shouldConvert){
        this.uploadedFile = []
        return
      }
    }

    //TODO: handle manual bundles.
    this.uploadInProgress = true
    this.fastenApi.createManualSource(processingFile).subscribe(
      (respData) => {
      },
      (err) => {
        console.log(err)
        this.uploadInProgress = false
        this.uploadErrorMsg = "Error uploading file: " + (extractErrorFromResponse(err)|| "Unknown Error")
      },
      () => {
        this.uploadInProgress = false
        this.uploadedFile = []
      }
    )
  }

  // Detects a C-CDA / CCD document upload by MIME type or file extension. The browser does not
  // always set a reliable `type` for .ccd/.cda, so extension is the primary signal.
  private isCcdaFile(file: File): boolean {
    const name = (file.name || "").toLowerCase()
    return file.type === "text/xml" || file.type === "application/xml" ||
      name.endsWith(".xml") || name.endsWith(".ccd") || name.endsWith(".ccda") || name.endsWith(".cda")
  }

  showCcdaWarningModal(): Promise<boolean> {


    return this.modalService.open(this.ccdaWarningModalRef).result.then<boolean>(
      (result) => {
        //convert button clicked, .close()
        return true //convert from CCDA -> FHIR.
      }
    ).catch((reason) => {
      // x or cancel button clicked, .dismiss()
      return false
    })
  }

}

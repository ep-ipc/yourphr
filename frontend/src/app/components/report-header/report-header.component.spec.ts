import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ReportHeaderComponent } from './report-header.component';
import {FastenApiService} from '../../services/fasten-api.service';
import {of} from 'rxjs';
import { RouterTestingModule } from '@angular/router/testing';
import { NgbModal, NgbModule } from '@ng-bootstrap/ng-bootstrap';

describe('ReportHeaderComponent', () => {
  let component: ReportHeaderComponent;
  let fixture: ComponentFixture<ReportHeaderComponent>;
  let mockedFastenApiService

  beforeEach(async () => {
    mockedFastenApiService = jasmine.createSpyObj('FastenApiService', ['getResources', 'getSummary', 'getIPSExport'])

    await TestBed.configureTestingModule({
      imports: [ RouterTestingModule, NgbModule ],
      declarations: [ ReportHeaderComponent ],
      providers: [{
        provide: FastenApiService,
        useValue: mockedFastenApiService
      }]
    })
    .compileComponents();
    mockedFastenApiService.getResources.and.returnValue(of({}));
    mockedFastenApiService.getSummary.and.returnValue(of({sources: []}));

    fixture = TestBed.createComponent(ReportHeaderComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('Save Report (#523)', () => {
    // The button used to be inert AND carried routerLink="/", so pressing it threw you off the page.
    it('should not download until the warning is accepted', () => {
      component.saveReport(new MouseEvent('click'));

      expect(mockedFastenApiService.getIPSExport).not.toHaveBeenCalled();
    });

    it('should download the HTML report once accepted', async () => {
      const modal = TestBed.inject(NgbModal);
      spyOn(modal, 'open').and.returnValue({result: Promise.resolve('download')} as any);

      component.saveReport(new MouseEvent('click'));
      await Promise.resolve();
      await Promise.resolve();

      expect(mockedFastenApiService.getIPSExport).toHaveBeenCalledWith('html');
    });

    // Dismissing must be a real cancel, not a delayed yes.
    it('should download nothing when the warning is dismissed', async () => {
      const modal = TestBed.inject(NgbModal);
      spyOn(modal, 'open').and.returnValue({result: Promise.reject('dismissed')} as any);

      component.saveReport(new MouseEvent('click'));
      await Promise.resolve();
      await Promise.resolve();

      expect(mockedFastenApiService.getIPSExport).not.toHaveBeenCalled();
    });

    it('should leave Export to PDF on the PDF format', () => {
      component.getIPSExport(new MouseEvent('click'));

      expect(mockedFastenApiService.getIPSExport).toHaveBeenCalledWith('pdf');
    });
  });
});

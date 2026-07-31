import {ComponentFixture, TestBed} from '@angular/core/testing';
import {RouterTestingModule} from '@angular/router/testing';
import {AttributionsComponent} from './attributions.component';

describe('AttributionsComponent', () => {
  let fixture: ComponentFixture<AttributionsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AttributionsComponent, RouterTestingModule],
    }).compileComponents();
    fixture = TestBed.createComponent(AttributionsComponent);
    fixture.detectChanges();
  });

  it('creates and shows the CMS Blue Button notice', () => {
    expect(fixture.componentInstance).toBeTruthy();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('CMS Blue Button');
    expect(text).toContain('not endorsed or certified');
  });
});

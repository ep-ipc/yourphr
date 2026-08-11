import {Component, OnInit} from '@angular/core';
import {User} from '../../models/fasten/user';
import {ActivatedRoute, Router} from '@angular/router';
import {ToastService} from '../../services/toast.service';
import {ToastNotification, ToastType} from '../../models/fasten/toast';
import {environment} from '../../../environments/environment';
import {AuthService} from '../../services/auth.service';
import {FastenApiService} from '../../services/fasten-api.service';
import {Location} from '@angular/common';

@Component({
    selector: 'app-auth-signin',
    templateUrl: './auth-signin.component.html',
    styleUrls: ['./auth-signin.component.scss'],
    standalone: false
})
export class AuthSigninComponent implements OnInit {
  loading = false

  submitted = false
  existingUser: User = new User()
  errorMsg = ""
  showExternalIdP: boolean = environment.environment_cloud

  // Public demo instance: offer one-click sign-in to the shared demo account (#495). Read from
  // the unauthenticated instance endpoint, false on every ordinary install.
  demoEnabled = false
  demoLoading = false

  // Whether to offer "Create an Account" (#498). Starts true: signup has always been open, so an
  // instance that never published the key must keep behaving as it did. The backend is the real
  // gate — this just avoids offering a link that would 403.
  signupEnabled = true

  constructor(
    private authService: AuthService,
    private fastenApiService: FastenApiService,
    private router: Router,
    private route: ActivatedRoute,
    private location: Location,
    private toastService: ToastService,
  ) { }

  ngOnInit(): void {

    // An unreachable or erroring instance endpoint must leave the demo button hidden rather than
    // showing a button that cannot work.
    this.fastenApiService.getPublicInstanceInfo().subscribe({
      next: (info) => {
        this.demoEnabled = info?.demo_enabled === true
        this.signupEnabled = info?.signup_enabled !== false
      },
      error: () => {
        this.demoEnabled = false
        // Leave signup offered on error: hiding it would strand someone on a reachable instance
        // whose only problem was one failed request.
        this.signupEnabled = true
      },
    })

    const idpType = this.route.snapshot.paramMap.get('idp_type')
    if(idpType){
      this.loading = true
      const params = new URLSearchParams(window.location.hash.substring(1))
      const code = params.get('code') // eyJhbGciOiJSUzI1...rest_of_ID_Token
      const state = params.get('state') // eyJhbGciOiJSUzI1...rest_of_ID_Token

      this.resetUrlOnCallback()
      this.authService.IdpCallback(idpType, state, code)
        .then(() => this.authService.GetCurrentUser())
        .then((currentUser) => {
          //for cloud users ONLY, skip the encryption manager.
          //TODO: replace Pouchdb.
          const userId = currentUser.sub
          //TODO: static IV, must be removed/replaced.
          return {username: userId, key: userId}
        })
        .then(() => this.router.navigateByUrl('/dashboard'))
        .catch((err)=>{
          console.error("idpCallback error:", err)
          const toastNotification = new ToastNotification()
          toastNotification.type = ToastType.Error
          toastNotification.message = "an error occurred while signing in"
          this.toastService.show(toastNotification)
        })
    }

  }

  signinSubmit(){
    this.submitted = true;
    this.loading = true

    this.authService.Signin(this.existingUser.username, this.existingUser.password)
      .then(() => {
        this.loading = false
        this.router.navigateByUrl('/dashboard')
      })
      .catch((err)=>{
        this.loading = false
        if(err?.name){
          this.errorMsg = "username or password is incorrect"
        } else{
          this.errorMsg = "an unknown error occurred during sign-in"
        }
        const toastNotification = new ToastNotification()
        toastNotification.type = ToastType.Error
        toastNotification.message = this.errorMsg
        this.toastService.show(toastNotification)
      })
  }

  // demoSignin enters the shared demo account with no credential entry (#495). The credentials
  // live in the instance's configuration and are checked server-side, so nothing is typed here
  // and nothing is held in this bundle.
  demoSignin(){
    this.demoLoading = true
    this.errorMsg = ""

    this.authService.DemoSignin()
      .then(() => {
        this.demoLoading = false
        this.router.navigateByUrl('/dashboard')
      })
      .catch((err)=>{
        this.demoLoading = false
        console.error("demo signin error:", err)
        this.errorMsg = "the demo is not available right now"
        const toastNotification = new ToastNotification()
        toastNotification.type = ToastType.Error
        toastNotification.message = this.errorMsg
        this.toastService.show(toastNotification)
      })
  }

  resetUrlOnCallback(){
    //reset the url, removing the params and fragment from the current url.
    const urlTree = this.router.createUrlTree(["/auth/signin"],{
      relativeTo: this.route,
    });
    this.location.replaceState(urlTree.toString());
  }

  idpConnectHello($event){
    this.authService.IdpConnect('hello').catch(console.error)
  }
}

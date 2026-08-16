package handler

import (
	"fmt"
	sourceDefinitions "github.com/fastenhealth/fasten-onprem/backend/pkg/sources/definitions"
	"github.com/gin-gonic/gin"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// SECURITY: there are security implications to this, this may require some additional authentication to limit misuse
// this is a whitelisted CORS proxy, it is only used to proxy requests to Token Exchange urls for specified endpoint
func CORSProxy(c *gin.Context) {

	endpointId := strings.Trim(c.Param("endpointId"), "/")

	//get the endpoint definition
	endpointDefinition, err := sourceDefinitions.GetSourceDefinition(sourceDefinitions.GetSourceConfigOptions{
		EndpointId: endpointId,
	})

	if err != nil {
		// 501, not 404. This proxy needs the upstream provider definitions to know which endpoint
		// it may relay to and what URL prefix to confine the request to — both of which are the
		// security controls below. Those definitions are a commercial dependency YourPHR does not
		// have (fastenhealth/fasten-onprem#629), so this fails for every endpointId, not just an
		// unknown one. A 404 reads as "you passed a bad id" and sends the caller hunting for a
		// right one that does not exist.
		//
		// Reached only when a source sets cors_relay_required, which comes from Fasten's hosted
		// lighthouse. Its discovery endpoints (/search, /catalog) currently return nothing, so no
		// endpointId can be obtained through the UI and this path is unreachable in practice —
		// which is a fact about an external service, not a guarantee. See yourphr#476.
		c.JSON(http.StatusNotImplemented, gin.H{
			"error": "the CORS relay requires the upstream provider source definitions, which are " +
				"not available in YourPHR",
		})
		return
	}

	//SECURITY: if the endpoint definition does not have CORSRelayRequired set to true, then return a 404
	if endpointDefinition.CORSRelayRequired != true {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "endpoint does not require CORS Relay.",
		})
		return
	}

	//SECURITY: the proxy URL must start with the same URL as the endpoint.TokenUri
	corsUrl := fmt.Sprintf("https://%s", strings.TrimPrefix(c.Param("proxyPath"), "/"))

	//we'll lowercase to normalize the comparison
	if !strings.HasPrefix(strings.ToLower(corsUrl), strings.ToLower(endpointDefinition.TokenEndpoint)) {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "invalid proxy URL, must match TokenEndpoint",
		})
		return
	}

	remote, err := url.Parse(corsUrl)
	remote.RawQuery = c.Request.URL.Query().Encode()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "invalid proxy URL, could not parse",
		})
		return
	}

	proxy := httputil.ReverseProxy{}
	//Define the director func
	//This is a good place to log, for example
	proxy.Director = func(req *http.Request) {
		req.Header = c.Request.Header
		req.Header.Add("X-Forwarded-Host", req.Host)
		req.Header.Add("X-Origin-Host", remote.Host)
		req.Host = remote.Host
		req.URL.Scheme = remote.Scheme
		req.URL.Host = remote.Host
		log.Print(c.Param("proxyPath"))
		req.URL.Path = remote.Path
		req.Body = c.Request.Body

		//TODO: throw an error if the remote.Host is not allowed
	}

	proxy.ModifyResponse = func(r *http.Response) error {
		//b, _ := ioutil.ReadAll(r.Body)
		//buf := bytes.NewBufferString("Monkey")
		//buf.Write(b)
		//r.Body = ioutil.NopCloser(buf)
		r.Header.Set("Access-Control-Allow-Methods", "GET,HEAD")
		r.Header.Set("Access-Control-Allow-Credentials", "true")
		r.Header.Set("Access-Control-Allow-Origin", "*")
		return nil
	}

	proxy.ServeHTTP(c.Writer, c.Request)
}

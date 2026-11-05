# Java application previews

Java course packages can use the existing PBL application preview lifecycle by declaring
`runtime.profile: "java"`, Java `buildSources`, and an application command of
`["java", "-cp", "/tmp/pbl-project-build", "your.package.Main", ...args]`.
The main class must match a declared Java source. The host compiles declared sources
(and permitted added sources) into the fixed build directory before starting Java.
Python packages retain their existing launch behavior.

Packages using this extension declare `pbl-v3-java-application@1` in their classroom
manifest. Older hosts reject the unsupported capability instead of accepting a
preview they cannot launch.

Deployment requires both this host support and a configured sandbox code template
with Python 3 (host workspace operations) and a JDK providing `java` and `javac` on
PATH. The JDK must support the language features used by the particular course.
Choose the code template through the existing sandbox configuration/settings.
No new environment variable is introduced, and setting a model key or a Java-related
variable cannot replace the host update or installation of a JDK. Changing the
configured template does not install tools into existing environments; recreate
those environments through the normal owner-scoped controls as needed.

This extension does not change preview interaction, document retention, source
fingerprinting, leases, or automatic restart rules. In particular, writing PLAN.md
continues to preserve the application; actual source changes use the existing
preview update checkpoint. Application model routing and credentials remain the
responsibility of the deployment/course model service, not this launcher.

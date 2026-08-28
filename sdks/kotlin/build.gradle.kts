plugins { kotlin("jvm") version "2.2.20" }

group = "dev.crosslink"
version = "0.1.0"

repositories { mavenCentral() }
dependencies { testImplementation(kotlin("test")) }
tasks.test { useJUnitPlatform() }
kotlin { jvmToolchain(17) }
